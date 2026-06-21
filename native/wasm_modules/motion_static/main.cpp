/*
 * debug.motion_static — Per-pixel motion stress test.
 *
 * Generates a sparse, fine-grained velocity field by thresholding
 * white-noise per pixel:
 *   noise = hash(pixel, seed)
 *   if noise > threshold: magnitude = (noise - threshold) / (1 - threshold) * swirl
 *   else:                 magnitude = 0
 * The active pixels' velocity direction is tangential to a circle
 * around the viewport center (concentric rotation), perturbed by a
 * per-pixel jitter draw.
 *
 * Why this is useful: motion blur consumers like McGuire's
 * reconstruction filter reduce per-pixel motion to a per-tile max,
 * which is great for big rigid objects but can collapse fine-grained
 * vector fields. This effect produces exactly that — randomly
 * scattered single-pixel motion vectors with non-uniform direction —
 * so we can characterise where the tile reduction breaks down and
 * decide whether a velocity pyramid is warranted.
 *
 * `opacity` blends an HSV-polar visualization of the motion vectors
 * (hue = direction, value = magnitude) on top of the input, scaled
 * by the per-pixel magnitude so non-moving pixels stay invisible at
 * any opacity. The motion pass always writes full-strength vectors
 * regardless of opacity, matching the convention in motion_rect /
 * motion_swarm.
 *
 * Class-like instance model: module_init() compiles the two shared
 * compute PSOs + publishes the schema once per type; each chain entry
 * gets its own State (params, stepping state, per-instance buffer/
 * textures) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "motion_static_shaders.h"

namespace motion_static {

struct Uniforms {
  float threshold;
  float swirl;
  float jitter;
  float seed;
  float opacity;
  float vis_scale;
  float _pad0;
  float _pad1;
};

// Per-instance state. One per chain entry.
struct State {
  gpu::Buffer  uniform_buf;
  gpu::Texture motion_tex;
  gpu::Texture zero_motion_tex;  // 1x1 rgba16float fallback bound when no upstream
  int  motion_w = 0;
  int  motion_h = 0;
  bool initialized = false;

  // Schema-mirrored params
  float threshold = 0.95f;
  float swirl     = 0.01f;
  float jitter    = 0.2f;
  int   seed      = 0;
  float opacity   = 1.0f;
  float vis_scale = 100.0f;

  // Stepping state. The shader-facing seed is `seed + step_count`,
  // so each step shifts the noise pattern by a "different seed" worth.
  // `rate` controls automatic advancement (Hz). `step_accum` carries
  // fractional-step time across frames so a slow rate doesn't get
  // rounded away on fast tick loops. `step_value` mirrors the boolean
  // `step` schema field — any toggle (either direction) advances the
  // counter once.
  float        rate       = 60.0f;
  float        step_accum = 0.0f;
  unsigned int step_count = 0;
  bool         step_value = false;
};

// Type-shared: compiled once in module_init().
static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;

// Type-level setup: schema + the two shared compute PSOs.
void module_init() {
  state::init("debug.motion_static", {1, 0, 0},
    state::Schema()
      // 0..1 with default 0.95 — only the top 5% of pixels are
      // active by default. Crank it down to 0 to make every pixel
      // move; up to 0.99 for very sparse motion.
      .floatField("threshold", 0.95f, 0.0f, 1.0f,   state::PrimaryInput)
      // Magnitude in uv-per-frame at noise=1.0. Default 0.01 ≈ 1.3
      // px/frame at 128px viewport.
      .floatField("swirl",     0.01f, 0.0f, 0.05f,  state::PrimaryInput)
      // Per-pixel direction perturbation, [0..1]. 0 = purely
      // tangential, 1 = direction nearly random.
      .floatField("jitter",    0.2f,  0.0f, 1.0f,   state::PrimaryInput)
      .intField  ("seed",      0,     0,    1000,   state::PrimaryInput)
      // Hz at which the noise pattern auto-advances. 60 = step every
      // frame at 60fps; 0 = never auto-step (manual only). The
      // automatic advance accumulates fractional time so slow rates
      // remain accurate over long durations.
      .floatField("rate",      60.0f,  0.0f, 60.0f, state::PrimaryInput)
      // Manual step trigger: any toggle (true→false or false→true)
      // advances the noise pattern once. Pair this with rate=0 to
      // get a strictly user-driven stepping mode.
      .boolField ("step",      false,                state::PrimaryInput)
      // Opacity of the HSV-polar motion-vector overlay. 0 hides the
      // visualization completely (tex_in passes through unchanged);
      // 1 fully reveals it.
      .floatField("opacity",   1.0f,  0.0f, 1.0f,   state::PrimaryInput)
      // How aggressively to scale magnitude → brightness in the
      // visualization. swirl=0.01 → vis_scale=100 maps full magnitude
      // to value=1. Tweak alongside swirl when changing magnitude.
      .floatField("vis_scale", 100.0f, 1.0f, 500.0f, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryOutput)
      // Upstream render-outputs (auxiliary input). When connected, the
      // motion shader blends our per-pixel velocity field on top of the
      // incoming one — pixels below threshold inherit upstream, active
      // pixels override with this stage's local velocity.
      .renderOutputs(state::PrimaryInput, "render_outputs_in")
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("motion_static_color",  COLOR_SPV,  COLOR_SPV_SIZE);
  state::registerShaderSPV("motion_static_motion", MOTION_SPV, MOTION_SPV_SIZE,
                           "rgba16float", "write");
  auto cs_color  = gpu::Device::createShaderModuleByName("motion_static_color");
  auto cs_motion = gpu::Device::createShaderModuleByName("motion_static_motion");
  if (!cs_color || !cs_motion) return;

  s_pso_color = gpu::Device::createComputePSO(cs_color, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));

  s_pso_motion = gpu::Device::createComputePSO(cs_motion, "main", gpu::Bindings()
      .storageTex2d(0, gpu::TextureFormat::RGBA16F)
      .uniform(1)
      .tex2d(2));  // upstream motion (zero fallback when unwired)

  state::log("motion_static: module initialized");
}

// Per-instance construction: allocate State + its own GPU buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->motion_tex.release();
  s->zero_motion_tex.release();
  delete s;
}

// Per-instance init tail: reset params/stepping state + mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->threshold = 0.95f;
  s->swirl     = 0.01f;
  s->jitter    = 0.2f;
  s->seed      = 0;
  s->opacity   = 1.0f;
  s->vis_scale = 100.0f;
  s->rate      = 60.0f;
  s->step_accum = 0.0f;
  s->step_count = 0;
  s->step_value = false;
  s->initialized = false;
  s->motion_w = 0;
  s->motion_h = 0;

  if (!s_pso_color.valid() || !s_pso_motion.valid()) return;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (s->rate <= 0.0f) return;
  s->step_accum += float(dt);
  float interval = 1.0f / s->rate;
  // Loop in case rate is high relative to dt (catches up across
  // multiple intervals if a frame is delayed). Cap to avoid an
  // unbounded burst after a long pause — beyond ~32 steps in one
  // frame the user can't perceive the difference anyway.
  int safety = 32;
  while (s->step_accum >= interval && safety-- > 0) {
    s->step_count++;
    s->step_accum -= interval;
  }
  // If we hit the cap, drop any leftover accumulator so we don't
  // wedge in a steady-state burst.
  if (safety <= 0) s->step_accum = 0.0f;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "threshold")) {
      s->threshold = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "swirl")) {
      s->swirl = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "jitter")) {
      s->jitter = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "seed")) {
      s->seed = (int)state::patchFloat(i);
    } else if (state::pathIs(path, plen, "rate")) {
      s->rate = state::patchFloat(i);
      s->step_accum = 0.0f;  // restart accumulator on rate change
    } else if (state::pathIs(path, plen, "step")) {
      // Booleans patch as 0/1. Treat any toggle as a single advance
      // so the user can click the inspector checkbox to step.
      bool new_step = state::patchFloat(i) != 0.0f;
      if (new_step != s->step_value) {
        s->step_value = new_step;
        s->step_count++;
      }
    } else if (state::pathIs(path, plen, "opacity")) {
      s->opacity = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "vis_scale")) {
      s->vis_scale = state::patchFloat(i);
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Shader-facing seed combines the user-controlled `seed` with the
  // step counter so each step shifts the noise pattern. A small
  // multiplier on the user seed widely separates user-seed slots
  // from step-driven patterns; without it adjacent user seeds and
  // step counts could collide.
  float effective_seed = float(s->seed * 17 + int(s->step_count));
  Uniforms u = {
    s->threshold, s->swirl, s->jitter, effective_seed,
    s->opacity, s->vis_scale, 0.f, 0.f,
  };
  s->uniform_buf.writeOne(u);

  // Pass 1 — color: tex_in → tex_out, optionally with motion-vector overlay.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  // Motion pass — only when something downstream actually reads it.
  if (!state::isOutputConnected("render_outputs")) {
    gpu::Device::submit();
    return;
  }

  if (!s->motion_tex.valid() || s->motion_w != vp_w || s->motion_h != vp_h) {
    s->motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    s->motion_w = vp_w;
    s->motion_h = vp_h;
    if (s->motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", s->motion_tex.id);
    }
  }
  if (!s->motion_tex.valid()) return;

  // Resolve upstream motion (or 1x1 zero fallback when unwired).
  auto upstream = gpu::Device::textureForField("render_outputs_in/motion");
  if (!upstream.valid()) {
    if (!s->zero_motion_tex.valid()) {
      s->zero_motion_tex = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
    }
    upstream = s->zero_motion_tex;
  }

  // Pass 2 — motion: per-pixel velocity field, with upstream as the
  // baseline for inactive pixels.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(s->motion_tex, 0, 1);
    cp.setBuffer(s->uniform_buf, 1);
    cp.setTexture(upstream, 2, 0);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_static
