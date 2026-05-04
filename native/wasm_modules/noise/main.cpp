/*
 * generator.noise — Procedural noise generator.
 *
 * Standard params:
 *   algorithm   int        0 = white, 1 = value, 2 = simplex/perlin-style
 *                          fbm, 3 = static (TV-style animated white).
 *   scale       [0, 1]     spatial scale, mapped exponentially to cell sizes.
 *   contrast    [-1, +1]   bipolar contrast curve (signed gamma).
 *   seed        [0, 1]     fixed seed for deterministic patterns.
 *
 * Tuning params:
 *   octaves     int        1..6 (only meaningful for fbm).
 *   color       [0, 1]     0 = greyscale, 1 = independent RGB hashes.
 *   speed       [0, 1]     0 = freezes "static" mode; 1 = ~30 Hz reroll.
 *
 * Uses an internal accumulator to advance the static phase, per the
 * style guide's time-handling rule (no `elapsed * rate`).
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "noise_shaders.h"

namespace noise {

struct FuseUniforms {
  int   algorithm;
  float scale;
  float contrast;
  float seed;
  int   octaves;
  float color;
  float static_phase;
  float aspect_x;
  float aspect_y;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

static int   s_algorithm = 0;
static float s_scale = 0.5f;
static float s_contrast = 0.0f;
static float s_seed = 0.0f;
static int   s_octaves = 4;
static float s_color = 0.0f;
static float s_speed = 0.5f;

static float s_static_phase = 0.0f;  // accumulator (style guide §2.1)

static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  FuseUniforms u = {};
  u.algorithm = s_algorithm;
  u.scale = s_scale;
  u.contrast = s_contrast;
  u.seed = s_seed;
  u.octaves = s_octaves;
  u.color = s_color;
  u.static_phase = s_static_phase;
  u.aspect_x = ax;
  u.aspect_y = ay;
  s_uniform_buf.writeOne(u);
}

void init() {
  s_algorithm = 0;
  s_scale = 0.5f;
  s_contrast = 0.0f;
  s_seed = 0.0f;
  s_octaves = 4;
  s_color = 0.0f;
  s_speed = 0.5f;
  s_static_phase = 0.0f;

  s_initialized = false;

  state::init("generator.noise", {1, 0, 0},
    state::Schema()
      .intField("algorithm", 0,    0, 3,    state::PrimaryInput)
      .floatField("scale",   0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("contrast",0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("seed",    0.0f, 0.f, 1.f, state::PrimaryInput)
      .intField("octaves",   4,    1, 6,    state::SecondaryInput)
      .floatField("color",   0.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("speed",   0.5f, 0.f, 1.f, state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings().storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  state::registerFusion(state::FusionKind::StrictOutput,
                        PIXEL_WGSL, PIXEL_MSL,
                        s_uniform_buf.id, sizeof(FuseUniforms),
                        &prepare);
}

void tick(double dt) {
  // Advance the "static" phase as an accumulator. speed=0 freezes; speed=1 → 30 reroll/s.
  s_static_phase += static_cast<float>(dt) * (s_speed * 30.0f);
  // Wrap to keep the value bounded (any large modulus is fine).
  if (s_static_phase > 1.0e6f) s_static_phase -= 1.0e6f;
}

void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "algorithm")) s_algorithm = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "scale"))     s_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "contrast"))  s_contrast = state::patchFloat(i);
    else if (state::pathIs(p, l, "seed"))      s_seed = state::patchFloat(i);
    else if (state::pathIs(p, l, "octaves"))   s_octaves = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "color"))     s_color = state::patchFloat(i);
    else if (state::pathIs(p, l, "speed"))     s_speed = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::textureForField("tex_out");
  if (!output.valid()) return;

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace noise
