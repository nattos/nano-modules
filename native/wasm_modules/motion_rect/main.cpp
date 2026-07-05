/*
 * debug.motion_rect — Test producer for the canonical RenderOutputs rail.
 *
 * Overlays a moving colored rectangle on its input texture (color pass)
 * and writes per-pixel velocity vectors into an rgba16float side texture
 * (motion pass), publishing the side texture as `render_outputs/motion`
 * so downstream consumers (e.g. motion.blur) can pick it up via
 * the auto-binding struct rail mechanism.
 *
 * Pixels inside the rect carry velocity = (cx - cx_prev, cy - cy_prev)
 * in uv-space. Pixels outside the rect carry zero velocity. Tests
 * asserting the chain end-to-end can rely on "blurred inside the
 * rect's swept band, untouched elsewhere."
 *
 * Compositing (`opacity`) is independent of the motion-vector output
 * — a transparent rect still emits full-strength velocity so the
 * downstream motion blur acts on the underlying background texture
 * just as it would for an opaque rect. This lets the harness see
 * what motion blur does to the background without the rect's color
 * dominating the output.
 *
 * Animation patterns (`pattern`):
 *   0 — Lissajous: smoothly varying sinusoidal curve. Velocity rotates
 *       through every direction, useful for testing isotropic blur.
 *   1 — Rectilinear: cycles around the perimeter of an inset square.
 *       Velocity is axis-aligned within each side and turns 90° at
 *       corners — easier to read at a glance, and the motion-blur
 *       trail behind a side-traversing rect is straight-up
 *       horizontal/vertical.
 *
 * Class-like instance model: module_init() compiles the two shared
 * compute PSOs + publishes the schema once per type; each chain entry
 * gets its own State (params, animation accumulators, per-instance
 * uniform buffer/textures) via create(). All instance callbacks take
 * `self`.
 */

#include <gpu.h>
#include <host.h>
#include "motion_rect_shaders.h"

#include <cmath>

namespace motion_rect {

struct Uniforms {
  // 16-byte aligned: each row is one float4.
  float cx;
  float cy;
  float cx_prev;
  float cy_prev;

  float half_w;
  float half_h;
  float _pad0;
  float _pad1;

  float color_r;
  float color_g;
  float color_b;
  float opacity;
};

enum Pattern : int {
  PATTERN_LISSAJOUS   = 0,
  PATTERN_RECTILINEAR = 1,
};

// Per-instance state. One per chain entry.
struct State {
  gpu::Buffer  uniform_buf;
  gpu::Texture motion_tex;
  gpu::Texture zero_motion_tex;   // 1x1 rgba16float fallback bound when no upstream
  int  motion_w = 0;
  int  motion_h = 0;
  bool initialized = false;

  // Animation params (CPU-side). cx/cy are normalized to uv space [0, 1].
  float size = 0.2f;
  float speed = 1.0f;
  float color_r = 1.0f;
  float color_g = 0.4f;
  float color_b = 0.8f;
  float opacity = 1.0f;
  int   pattern = PATTERN_LISSAJOUS;

  double t = 0.0;
  float cx = 0.5f;
  float cy = 0.5f;
  float cx_prev = 0.5f;
  float cy_prev = 0.5f;
  bool  have_prev = false;
};

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;

static inline float lerp1(float a, float b, float t) {
  return a + (b - a) * t;
}

// Type-level setup: schema + the two shared compute PSOs.
void module_init() {
  state::init("debug.motion_rect", {1, 0, 0},
    state::Schema()
      .floatField("size",    0.2f, 0.02f, 0.5f, state::PrimaryInput)
      .floatField("speed",   1.0f, 0.0f,  5.0f, state::PrimaryInput)
      .floatField("opacity", 1.0f, 0.0f,  1.0f, state::PrimaryInput)
      .selectField("pattern", PATTERN_LISSAJOUS, state::PrimaryInput, {
        {"Lissajous",   PATTERN_LISSAJOUS},
        {"Rectilinear", PATTERN_RECTILINEAR},
      })
      .rgbField("color",   1.0f, 0.4f,  0.8f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      // Upstream render-outputs (auxiliary input). When connected and
      // motion is valid, the motion shader blends our local velocity on
      // top of the incoming field — pixels outside our rect inherit
      // upstream motion, pixels inside override it. Schema-compatible
      // with any other render_outputs producer (auto-bind matches by
      // shape, not field name).
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
      .capability(state::Capability::SeekableApproximate)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Two compute shaders, two storage formats. The format hint is
  // per-shader because naga's WGSL pass substitutes a single
  // `texture_storage_2d<...>` declaration.
  state::registerShaderSPV("motion_rect_color",  COLOR_SPV,  COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_rect_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_rect_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_rect_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1)
      .uniform(2));
  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)
      .uniform(1)
      .tex2d(2));  // upstream motion texture (zero fallback when unwired)

  state::log("motion_rect: module initialized");
}

// Per-instance construction: allocate State + its own GPU buffers.
void* create() {
  auto* st = new State();
  st->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return st;
}

void destroy(void* self) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  st->uniform_buf.release();
  st->motion_tex.release();
  st->zero_motion_tex.release();
  delete st;
}

// Per-instance init tail: reset animation state + mark ready.
void init(void* self) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  st->initialized = false;
  st->t = 0.0;
  st->cx = 0.5f; st->cy = 0.5f;
  st->cx_prev = 0.5f; st->cy_prev = 0.5f;
  st->have_prev = false;
  st->motion_w = 0;
  st->motion_h = 0;

  if (!s_pso_color.valid() || !s_pso_motion.valid()) return;
  if (!st->uniform_buf.valid()) return;

  st->initialized = true;
}

static void advance_lissajous(State& st, float w) {
  st.cx = 0.5f + 0.35f * std::sin(w * 1.3f);
  st.cy = 0.5f + 0.35f * std::sin(w * 0.9f + 0.7f);
}

static void advance_rectilinear(State& st, float w) {
  // Inset square corners; rect cycles clockwise: top-left → top-right
  // → bottom-right → bottom-left → top-left. Phase parameter wraps
  // every 4 sides; each side traversal takes 1 phase unit.
  static constexpr float LO = 0.15f;
  static constexpr float HI = 0.85f;
  float phase = std::fmod(w, 4.0f);
  if (phase < 0.0f) phase += 4.0f;
  if (phase < 1.0f) {
    st.cx = lerp1(LO, HI, phase);
    st.cy = LO;
  } else if (phase < 2.0f) {
    st.cx = HI;
    st.cy = lerp1(LO, HI, phase - 1.0f);
  } else if (phase < 3.0f) {
    st.cx = lerp1(HI, LO, phase - 2.0f);
    st.cy = HI;
  } else {
    st.cx = LO;
    st.cy = lerp1(HI, LO, phase - 3.0f);
  }
}

void tick(void* self, double dt) {
  auto* st = static_cast<State*>(self);
  if (!st || !st->initialized) return;
  st->t += dt;
  st->cx_prev = st->cx;
  st->cy_prev = st->cy;
  float w = float(st->t) * st->speed;
  if (st->pattern == PATTERN_RECTILINEAR) {
    advance_rectilinear(*st, w);
  } else {
    advance_lissajous(*st, w);
  }
  if (!st->have_prev) {
    st->cx_prev = st->cx;
    st->cy_prev = st->cy;
    st->have_prev = true;
  }
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "size")) {
      st->size = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "speed")) {
      st->speed = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "opacity")) {
      st->opacity = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "pattern")) {
      st->pattern = (int)state::patchFloat(i);
    } else if (state::pathIs(path, plen, "color")) {
      auto v = state::patchVec3(i);
      st->color_r = v.x; st->color_g = v.y; st->color_b = v.z;
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* st = static_cast<State*>(self);
  if (!st || !st->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Color pass always runs (the rect overlay is independent of whether
  // anyone consumes our render_outputs side rail).
  Uniforms u = {
    st->cx, st->cy,
    st->cx_prev, st->cy_prev,
    st->size * 0.5f, st->size * 0.5f,
    0.f, 0.f,
    st->color_r, st->color_g, st->color_b, st->opacity,
  };
  st->uniform_buf.writeOne(u);

  // Pass 1 — color: tex_in → tex_out with rect overlay.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(st->uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Motion pass — only run when downstream actually reads the rail.
  // No consumer → no point computing. (The rail's shape is fixed but
  // the texture stays unallocated until a reader appears.)
  if (!state::isOutputConnected("render_outputs")) {
    gpu::Device::submit();
    return;
  }

  // (Re)allocate the motion texture to match the current viewport. The
  // handle is published once per allocation; readers receive it via the
  // canonical `render_outputs` struct rail and the host's textureFields
  // map at "render_outputs/motion".
  if (!st->motion_tex.valid() || st->motion_w != vp_w || st->motion_h != vp_h) {
    st->motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    st->motion_w = vp_w;
    st->motion_h = vp_h;
    if (st->motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", st->motion_tex.id);
    }
  }
  if (!st->motion_tex.valid()) return;

  // Resolve the upstream motion texture — when our render_outputs_in
  // input is connected and the producer has populated it, blend onto
  // it. Otherwise bind a 1x1 zero fallback so the shader's unconditional
  // sample yields zero (and the binary mix collapses to local-only).
  auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
  if (!upstream.valid()) {
    if (!st->zero_motion_tex.valid()) {
      st->zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
    }
    upstream = st->zero_motion_tex;
  }

  // Pass 2 — motion: write velocity inside rect; outside the rect,
  // copy upstream motion through (or zero if none).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(st->motion_tex, 0, 1);
    cp.setBuffer(st->uniform_buf, 1);
    cp.setTexture(upstream, 2, 0);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_rect
