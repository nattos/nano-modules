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

static gpu::ComputePSO s_pso_color;
static gpu::ComputePSO s_pso_motion;
static gpu::Buffer     s_uniform_buf;
static gpu::Texture    s_motion_tex;
static int  s_motion_w = 0;
static int  s_motion_h = 0;
static bool s_initialized = false;

static float s_threshold = 0.95f;
static float s_swirl     = 0.01f;
static float s_jitter    = 0.2f;
static int   s_seed      = 0;
static float s_opacity   = 1.0f;
static float s_vis_scale = 100.0f;

// Stepping state. The shader-facing seed is `s_seed + s_step_count`,
// so each step shifts the noise pattern by a "different seed" worth.
// `s_rate` controls automatic advancement (Hz). `s_step_accum` carries
// fractional-step time across frames so a slow rate doesn't get
// rounded away on fast tick loops. `s_step_value` mirrors the boolean
// `step` schema field — any toggle (either direction) advances the
// counter once.
static float s_rate          = 60.0f;
static float s_step_accum    = 0.0f;
static unsigned int s_step_count = 0;
static bool  s_step_value    = false;

void init() {
  s_threshold = 0.95f;
  s_swirl     = 0.01f;
  s_jitter    = 0.2f;
  s_seed      = 0;
  s_opacity   = 1.0f;
  s_vis_scale = 100.0f;
  s_rate      = 60.0f;
  s_step_accum = 0.0f;
  s_step_count = 0;
  s_step_value = false;
  s_initialized = false;

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
      .uniform(1));

  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("motion_static: initialized");
}

void tick(double dt) {
  if (s_rate <= 0.0f) return;
  s_step_accum += float(dt);
  float interval = 1.0f / s_rate;
  // Loop in case rate is high relative to dt (catches up across
  // multiple intervals if a frame is delayed). Cap to avoid an
  // unbounded burst after a long pause — beyond ~32 steps in one
  // frame the user can't perceive the difference anyway.
  int safety = 32;
  while (s_step_accum >= interval && safety-- > 0) {
    s_step_count++;
    s_step_accum -= interval;
  }
  // If we hit the cap, drop any leftover accumulator so we don't
  // wedge in a steady-state burst.
  if (safety <= 0) s_step_accum = 0.0f;
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "threshold")) {
      s_threshold = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "swirl")) {
      s_swirl = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "jitter")) {
      s_jitter = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "seed")) {
      s_seed = (int)state::patchFloat(i);
    } else if (state::pathIs(path, plen, "rate")) {
      s_rate = state::patchFloat(i);
      s_step_accum = 0.0f;  // restart accumulator on rate change
    } else if (state::pathIs(path, plen, "step")) {
      // Booleans patch as 0/1. Treat any toggle as a single advance
      // so the user can click the inspector checkbox to step.
      bool new_step = state::patchFloat(i) != 0.0f;
      if (new_step != s_step_value) {
        s_step_value = new_step;
        s_step_count++;
      }
    } else if (state::pathIs(path, plen, "opacity")) {
      s_opacity = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "vis_scale")) {
      s_vis_scale = state::patchFloat(i);
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  if (!s_motion_tex.valid() || s_motion_w != vp_w || s_motion_h != vp_h) {
    s_motion_tex = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
    s_motion_w = vp_w;
    s_motion_h = vp_h;
    if (s_motion_tex.valid()) {
      state::setGpuTexture("render_outputs/motion", s_motion_tex.id);
    }
  }
  if (!s_motion_tex.valid()) return;

  // Shader-facing seed combines the user-controlled `seed` with the
  // step counter so each step shifts the noise pattern. A small
  // multiplier on the user seed widely separates user-seed slots
  // from step-driven patterns; without it adjacent user seeds and
  // step counts could collide.
  float effective_seed = float(s_seed * 17 + int(s_step_count));
  Uniforms u = {
    s_threshold, s_swirl, s_jitter, effective_seed,
    s_opacity, s_vis_scale, 0.f, 0.f,
  };
  s_uniform_buf.writeOne(u);

  // Pass 1 — color: tex_in → tex_out, optionally with motion-vector overlay.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_color);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s_uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }
  // Pass 2 — motion: per-pixel velocity field.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_motion);
    cp.setTexture(s_motion_tex, 0, 1);
    cp.setBuffer(s_uniform_buf, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace motion_static
