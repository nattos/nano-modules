/*
 * debug.motion_swarm — Test producer for the canonical RenderOutputs
 * rail. A swarm of N small rectangles drift around the viewport in a
 * curl/swirl velocity field with per-rect random jitter.
 *
 * Velocity field at position (x, y) relative to viewport center
 * (0.5, 0.5):
 *   v = swirl   * (-dy,  dx)            // tangential rotation
 *     + radial  * normalize(dx, dy)     // outward / inward drift
 *     + random  * per-rect smooth noise // decorrelates trajectories
 *
 * Each rect publishes its own per-frame velocity (cx - cx_prev,
 * cy - cy_prev) into the canonical `render_outputs/motion` texture
 * at the pixels it covers, so the downstream motion blur sees a
 * realistic vector field instead of a single uniform sweep.
 *
 * `opacity` only affects the color pass — the motion vectors are
 * always at full strength, so a fully-transparent swarm still drives
 * motion blur over the underlying tex_in. That separation lets a test
 * harness see how motion blur reshapes a background without the
 * swarm rects themselves dominating the output.
 *
 * Class-like instance model: module_init() compiles the two shared
 * compute PSOs + publishes the schema once per type; each chain entry
 * gets its own State (params, rect pool, per-instance buffers/textures)
 * via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "motion_swarm_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace motion_swarm {

static constexpr int MAX_RECTS = 64;

struct GpuRectInst {
  // 16-byte aligned float4 fields — matches the WGSL StructuredBuffer
  // layout naga emits for `struct RectInst { float4 pos; float4 size;
  // float4 color; };`.
  float pos[4];   // cx, cy, cx_prev, cy_prev
  float size[4];  // half_w, half_h, pad, pad
  float color[4]; // r, g, b, opacity
};
static_assert(sizeof(GpuRectInst) == 48, "GpuRectInst must be 48 bytes");

struct GpuUniforms {
  int rect_count;
  int _pad_a;
  int _pad_b;
  int _pad_c;
};

struct CpuRectState {
  float cx, cy;
  float cx_prev, cy_prev;
  float color_r, color_g, color_b;
  // Two decorrelated phase offsets so each rect gets a unique noise
  // trajectory without needing a per-frame RNG draw.
  float seed_a, seed_b;
};

// Per-instance state. One per chain entry.
struct State {
  gpu::Buffer  rect_buf;
  gpu::Buffer  uniform_buf;
  gpu::Texture motion_tex;
  gpu::Texture zero_motion_tex;  // 1x1 rgba16float fallback bound when no upstream
  int          motion_w = 0;
  int          motion_h = 0;

  // CPU rect pool + GPU pack scratch.
  CpuRectState rects_cpu[MAX_RECTS];
  GpuRectInst  rects_gpu[MAX_RECTS];

  bool initialized = false;

  // Schema params
  int    count       = 16;
  float  size        = 0.05f;
  float  swirl       = 1.0f;
  float  radial      = 0.0f;
  float  randomness  = 0.3f;
  float  speed       = 1.0f;
  float  opacity     = 1.0f;
  int    seed        = 0;
  double t           = 0.0;
};

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;

// Tiny LCG, deterministic on a 32-bit seed. Used for both initial
// rect placement and per-rect color/seed assignment so swarms with
// the same `seed` schema value are bit-identical across runs.
static uint32_t lcg_next(uint32_t& state) {
  state = state * 1664525u + 1013904223u;
  return state;
}
static float lcg_unit(uint32_t& state) {
  return (lcg_next(state) >> 8) / float(1u << 24);
}

static void hsv_to_rgb(float h, float s, float v, float& r, float& g, float& b) {
  // h in [0, 1].
  float h6 = h * 6.f;
  int i = int(h6);
  if (i < 0) i = 0;
  if (i > 5) i = 5;
  float f = h6 - float(i);
  float p = v * (1.f - s);
  float q = v * (1.f - f * s);
  float t = v * (1.f - (1.f - f) * s);
  switch (i) {
    case 0: r=v; g=t; b=p; break;
    case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break;
    case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break;
    default: r=v; g=p; b=q; break;
  }
}

/// Reseed all MAX_RECTS slots from `st.seed`. Even slots beyond
/// `st.count` get populated so that bumping count at runtime doesn't
/// reveal uninitialised rects with zero-pos/black-color.
static void seed_rects(State& st) {
  uint32_t rng = uint32_t(st.seed) ^ 0xA17F2B91u;
  // First mix to avoid degenerate first values for low seeds.
  for (int i = 0; i < 4; i++) lcg_next(rng);

  for (int i = 0; i < MAX_RECTS; i++) {
    auto& r = st.rects_cpu[i];
    r.cx = lcg_unit(rng) * 0.8f + 0.1f;
    r.cy = lcg_unit(rng) * 0.8f + 0.1f;
    r.cx_prev = r.cx;
    r.cy_prev = r.cy;
    float hue = lcg_unit(rng);
    float sat = 0.7f + 0.3f * lcg_unit(rng);  // saturated, not pastel
    hsv_to_rgb(hue, sat, 1.f, r.color_r, r.color_g, r.color_b);
    r.seed_a = lcg_unit(rng);
    r.seed_b = lcg_unit(rng);
  }
}

// Type-level setup: schema + the two shared compute PSOs.
void module_init() {
  state::init("debug.motion_swarm", {1, 0, 0},
    state::Schema()
      .intField  ("count",      16,    1, MAX_RECTS, state::PrimaryInput)
      .floatField("size",       0.05f, 0.01f, 0.2f,  state::PrimaryInput)
      .floatField("swirl",      1.0f, -3.0f, 3.0f,   state::PrimaryInput)
      .floatField("radial",     0.0f, -2.0f, 2.0f,   state::PrimaryInput)
      .floatField("randomness", 0.3f,  0.0f, 2.0f,   state::PrimaryInput)
      .floatField("speed",      1.0f,  0.0f, 5.0f,   state::PrimaryInput)
      .floatField("opacity",    1.0f,  0.0f, 1.0f,   state::PrimaryInput)
      .intField  ("seed",       0,     0,    1000,   state::PrimaryInput)
      .textureField("tex_in",   state::PrimaryInput)
      .textureField("tex_out",  state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      // Upstream render-outputs (auxiliary input). When connected, the
      // motion shader blends our swarm's per-pixel velocity on top of
      // the incoming field — pixels outside any rect inherit upstream,
      // pixels inside override with this swarm's own motion.
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("motion_swarm_color",  COLOR_SPV,  COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_swarm_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_swarm_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_swarm_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)                                       // inputTex
      .storageTex2d(1)     // outputTex
      .storage(2)                                     // rects (read-only storage)
      .uniform(3));                                   // Uniforms

  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)   // motionTex
      .storage(1)                                     // rects
      .uniform(2)                                     // Uniforms
      .tex2d(3));                                     // upstream motion (zero
                                                      //  fallback when unwired)

  state::log("motion_swarm: module initialized");
}

// Per-instance construction: allocate State + its own GPU buffers.
void* create() {
  auto* st = new State();
  st->rect_buf = gpu::Device::createBuffer(
      sizeof(GpuRectInst) * MAX_RECTS, gpu::BufferUsage::Storage);
  st->uniform_buf = gpu::Device::createBuffer(
      sizeof(GpuUniforms), gpu::BufferUsage::Uniform);
  return st;
}

void destroy(void* self) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  st->rect_buf.release();
  st->uniform_buf.release();
  st->motion_tex.release();
  st->zero_motion_tex.release();
  delete st;
}

// Per-instance init tail: reset params, seed the rect pool, mark ready.
void init(void* self) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  st->count       = 16;
  st->size        = 0.05f;
  st->swirl       = 1.0f;
  st->radial      = 0.0f;
  st->randomness  = 0.3f;
  st->speed       = 1.0f;
  st->opacity     = 1.0f;
  st->seed        = 0;
  st->t           = 0.0;
  st->motion_w    = 0;
  st->motion_h    = 0;
  st->initialized = false;

  seed_rects(*st);

  if (!s_pso_color.valid() || !s_pso_motion.valid()) return;
  if (!st->rect_buf.valid() || !st->uniform_buf.valid()) return;

  st->initialized = true;
  state::log("motion_swarm: initialized");
}

void tick(void* self, double dt) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  if (!st->initialized) return;
  st->t += dt;
  float fdt = float(dt) * st->speed;

  for (int i = 0; i < st->count; i++) {
    auto& r = st->rects_cpu[i];
    r.cx_prev = r.cx;
    r.cy_prev = r.cy;

    float dx = r.cx - 0.5f;
    float dy = r.cy - 0.5f;
    float rmag = std::sqrt(dx*dx + dy*dy);
    float inv_rmag = 1.f / (rmag + 1e-5f);

    // Tangential curl (rotation about center) + radial drift.
    float vx = -dy * st->swirl + dx * inv_rmag * st->radial;
    float vy =  dx * st->swirl + dy * inv_rmag * st->radial;

    // Per-rect smooth noise. Two sinusoids with rect-specific phase
    // and (slightly) frequency. Decoupled enough that no two rects
    // share trajectories even when count is high.
    float t = float(st->t);
    float t1 = t * (0.5f + 0.7f * r.seed_a) + r.seed_a * 6.2832f;
    float t2 = t * (0.5f + 0.7f * r.seed_b) + r.seed_b * 6.2832f + 1.5708f;
    vx += std::sin(t1) * st->randomness;
    vy += std::cos(t2) * st->randomness;

    r.cx += vx * fdt;
    r.cy += vy * fdt;

    // Toroidal wrap. Adjust prev along with current so cx-cx_prev
    // stays small across wrap-around frames (otherwise the motion
    // shader would emit a viewport-spanning velocity for one frame).
    if (r.cx > 1.f)  { r.cx -= 1.f; r.cx_prev -= 1.f; }
    if (r.cx < 0.f)  { r.cx += 1.f; r.cx_prev += 1.f; }
    if (r.cy > 1.f)  { r.cy -= 1.f; r.cy_prev -= 1.f; }
    if (r.cy < 0.f)  { r.cy += 1.f; r.cy_prev += 1.f; }
  }
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  bool seed_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "count")) {
      int c = (int)state::patchFloat(i);
      if (c < 1) c = 1;
      if (c > MAX_RECTS) c = MAX_RECTS;
      st->count = c;
    } else if (state::pathIs(path, plen, "size")) {
      st->size = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "swirl")) {
      st->swirl = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "radial")) {
      st->radial = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "randomness")) {
      st->randomness = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "speed")) {
      st->speed = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "opacity")) {
      st->opacity = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "seed")) {
      int new_seed = (int)state::patchFloat(i);
      if (new_seed != st->seed) {
        st->seed = new_seed;
        seed_changed = true;
      }
    }
  }
  if (seed_changed) seed_rects(*st);
}

void render(void* self, int vp_w, int vp_h) {
  auto* st = static_cast<State*>(self);
  if (!st || !st->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Pack CPU state into the GPU layout. Only `st->count` slots are
  // populated/read — the rest of the buffer keeps last-frame values
  // but is ignored by the shaders' index-bounded loops.
  float half = st->size * 0.5f;
  for (int i = 0; i < st->count; i++) {
    const auto& src = st->rects_cpu[i];
    auto& dst = st->rects_gpu[i];
    dst.pos[0]   = src.cx;
    dst.pos[1]   = src.cy;
    dst.pos[2]   = src.cx_prev;
    dst.pos[3]   = src.cy_prev;
    dst.size[0]  = half;
    dst.size[1]  = half;
    dst.size[2]  = 0.f;
    dst.size[3]  = 0.f;
    dst.color[0] = src.color_r;
    dst.color[1] = src.color_g;
    dst.color[2] = src.color_b;
    dst.color[3] = st->opacity;
  }
  st->rect_buf.writeBytes(st->rects_gpu, int(sizeof(GpuRectInst)) * st->count);

  GpuUniforms u = { st->count, 0, 0, 0 };
  st->uniform_buf.writeOne(u);

  // Pass 1 — color: tex_in → tex_out, alpha-blending each rect.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(st->rect_buf, 2);
    cp.setBuffer(st->uniform_buf, 3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Motion pass — only run when a downstream consumer reads the rail.
  if (!state::isOutputConnected("render_outputs")) {
    gpu::Device::submit();
    return;
  }

  // (Re)allocate the motion texture per viewport; publish the handle
  // once per allocation. Same convention as motion_rect.
  if (!st->motion_tex.valid() || st->motion_w != vp_w || st->motion_h != vp_h) {
    st->motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    st->motion_w = vp_w;
    st->motion_h = vp_h;
    if (st->motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", st->motion_tex.id);
    }
  }
  if (!st->motion_tex.valid()) return;

  // Resolve upstream motion (or the 1x1 zero fallback when nothing is
  // wired in). textureLoad on the fallback's out-of-bounds coords
  // returns zero per WebGPU spec, so the shader's unconditional sample
  // is safe.
  auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
  if (!upstream.valid()) {
    if (!st->zero_motion_tex.valid()) {
      st->zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
    }
    upstream = st->zero_motion_tex;
  }

  // Pass 2 — motion: write velocity inside any rect, fall back to
  // upstream motion outside every rect.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(st->motion_tex, 0, 1);
    cp.setBuffer(st->rect_buf, 1);
    cp.setBuffer(st->uniform_buf, 2);
    cp.setTexture(upstream, 3, 0);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_swarm
