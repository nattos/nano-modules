/*
 * video.curve — Power curve applied to RGB and alpha.
 *
 * Per the style guide, exposed as a normalized signed slider. The
 * parameter feeds an exponential mapping so the perceived effect is
 * symmetric and continuous around 0.
 *
 *   slider -1.0  →  exponent 8.0       (heavy downward squash)
 *   slider  0.0  →  exponent 1.0       (identity)
 *   slider +1.0  →  exponent 1.0/8.0   (heavy upward squash)
 *
 * Two independent sliders for RGB and alpha so colour and matte can be
 * shaped separately.
 */

#include <gpu.h>
#include <host.h>
#include "curve_shaders.h"

#include <cmath>

namespace curve {

struct Uniforms {
  float rgb_exp;
  float alpha_exp;
  float _pad[2];
};

static float s_rgb_curve = 0.0f;
static float s_alpha_curve = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

static float curve_to_exp(float c) {
  // pow(8, -c): c=-1 → 8, c=0 → 1, c=+1 → 1/8.
  return std::pow(2.0f, -c * 3.0f);  // 2^3 == 8
}

void init() {
  s_rgb_curve = 0.0f;
  s_alpha_curve = 0.0f;
  s_initialized = false;

  state::init("video.curve", {1, 0, 0},
    state::Schema()
      .floatField("rgb",   0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("alpha", 0.0f, -1.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main");
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "rgb"))
      s_rgb_curve = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "alpha"))
      s_alpha_curve = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  Uniforms u = {
    curve_to_exp(s_rgb_curve),
    curve_to_exp(s_alpha_curve),
    {0, 0},
  };
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace curve
