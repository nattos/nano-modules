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
static CpuRectState s_rects_cpu[MAX_RECTS];
static GpuRectInst  s_rects_gpu[MAX_RECTS];

static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_rect_buf;
static gpu::Buffer     s_uniform_buf;
static gpu::Texture    s_motion_tex;
static int  s_motion_w = 0;
static int  s_motion_h = 0;
static bool s_initialized = false;

// Schema params
static int   s_count       = 16;
static float s_size        = 0.05f;
static float s_swirl       = 1.0f;
static float s_radial      = 0.0f;
static float s_randomness  = 0.3f;
static float s_speed       = 1.0f;
static float s_opacity     = 1.0f;
static int   s_seed        = 0;
static double s_t = 0.0;

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

/// Reseed all MAX_RECTS slots from `s_seed`. Even slots beyond
/// `s_count` get populated so that bumping count at runtime doesn't
/// reveal uninitialised rects with zero-pos/black-color.
static void seed_rects() {
  uint32_t rng = uint32_t(s_seed) ^ 0xA17F2B91u;
  // First mix to avoid degenerate first values for low seeds.
  for (int i = 0; i < 4; i++) lcg_next(rng);

  for (int i = 0; i < MAX_RECTS; i++) {
    auto& r = s_rects_cpu[i];
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

void init() {
  s_count       = 16;
  s_size        = 0.05f;
  s_swirl       = 1.0f;
  s_radial      = 0.0f;
  s_randomness  = 0.3f;
  s_speed       = 1.0f;
  s_opacity     = 1.0f;
  s_seed        = 0;
  s_t           = 0.0;
  s_initialized = false;

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
  );

  seed_rects();

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("motion_swarm_color",  COLOR_SPV,  COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_swarm_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_swarm_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_swarm_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)                                       // inputTex
      .storageTex2d(1, gpu::TextureFormat::RGBA8)     // outputTex
      .storage(2)                                     // rects (read-only storage)
      .uniform(3));                                   // Uniforms

  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)   // motionTex
      .storage(1)                                     // rects
      .uniform(2));                                   // Uniforms

  s_rect_buf = gpu::Device::createBuffer(
      sizeof(GpuRectInst) * MAX_RECTS, gpu::BufferUsage::Storage);
  s_uniform_buf = gpu::Device::createBuffer(
      sizeof(GpuUniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("motion_swarm: initialized");
}

void tick(double dt) {
  if (!s_initialized) return;
  s_t += dt;
  float fdt = float(dt) * s_speed;

  for (int i = 0; i < s_count; i++) {
    auto& r = s_rects_cpu[i];
    r.cx_prev = r.cx;
    r.cy_prev = r.cy;

    float dx = r.cx - 0.5f;
    float dy = r.cy - 0.5f;
    float rmag = std::sqrt(dx*dx + dy*dy);
    float inv_rmag = 1.f / (rmag + 1e-5f);

    // Tangential curl (rotation about center) + radial drift.
    float vx = -dy * s_swirl + dx * inv_rmag * s_radial;
    float vy =  dx * s_swirl + dy * inv_rmag * s_radial;

    // Per-rect smooth noise. Two sinusoids with rect-specific phase
    // and (slightly) frequency. Decoupled enough that no two rects
    // share trajectories even when count is high.
    float t = float(s_t);
    float t1 = t * (0.5f + 0.7f * r.seed_a) + r.seed_a * 6.2832f;
    float t2 = t * (0.5f + 0.7f * r.seed_b) + r.seed_b * 6.2832f + 1.5708f;
    vx += std::sin(t1) * s_randomness;
    vy += std::cos(t2) * s_randomness;

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

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  bool seed_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "count")) {
      int c = (int)state::patchFloat(i);
      if (c < 1) c = 1;
      if (c > MAX_RECTS) c = MAX_RECTS;
      s_count = c;
    } else if (state::pathIs(path, plen, "size")) {
      s_size = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "swirl")) {
      s_swirl = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "radial")) {
      s_radial = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "randomness")) {
      s_randomness = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "speed")) {
      s_speed = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "opacity")) {
      s_opacity = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "seed")) {
      int new_seed = (int)state::patchFloat(i);
      if (new_seed != s_seed) {
        s_seed = new_seed;
        seed_changed = true;
      }
    }
  }
  if (seed_changed) seed_rects();
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // (Re)allocate the motion texture per viewport; publish the handle
  // once per allocation. Same convention as motion_rect.
  if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
    s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    s_motion_w = vp_w;
    s_motion_h = vp_h;
    if (s_motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
    }
  }
  if (!s_motion_tex.valid()) return;

  // Pack CPU state into the GPU layout. Only `s_count` slots are
  // populated/read — the rest of the buffer keeps last-frame values
  // but is ignored by the shaders' index-bounded loops.
  float half = s_size * 0.5f;
  for (int i = 0; i < s_count; i++) {
    const auto& src = s_rects_cpu[i];
    auto& dst = s_rects_gpu[i];
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
    dst.color[3] = s_opacity;
  }
  s_rect_buf.writeBytes(s_rects_gpu, int(sizeof(GpuRectInst)) * s_count);

  GpuUniforms u = { s_count, 0, 0, 0 };
  s_uniform_buf.writeOne(u);

  // Pass 1 — color: tex_in → tex_out, alpha-blending each rect.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_rect_buf, 2);
    cp.setBuffer(s_uniform_buf, 3);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }
  // Pass 2 — motion: write velocity inside any rect, zero outside.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(s_motion_tex, 0, 1);
    cp.setBuffer(s_rect_buf, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_swarm
