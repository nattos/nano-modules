/*
 * video.levels — Photoshop-style input/output remapping with gamma.
 *
 *   x = saturate((in - in_low) / (in_high - in_low))
 *   x = pow(x, gamma_exp)
 *   out = lerp(out_low, out_high, x)
 *
 * `gamma` is normalized [-1, 1] using the same exponential mapping as
 * the `curve` effect: -1 → exp 8 (crush mids dark), 0 → 1 (identity),
 * +1 → exp 1/8 (lift mids bright).
 *
 * Standard params (in_low/in_high/gamma) live up front; the output
 * remap (out_low/out_high) is tuning, since most patches just want
 * input-side adjustment.
 */

#include <gpu.h>
#include <host.h>
#include "levels_shaders.h"

#include <cmath>

namespace levels {

struct Uniforms {
  float in_low, in_high;
  float gamma_exp;
  float out_low, out_high;
  float _pad[3];
};

static float s_in_low = 0.0f;
static float s_in_high = 1.0f;
static float s_gamma = 0.0f;
static float s_out_low = 0.0f;
static float s_out_high = 1.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_in_low = 0.0f; s_in_high = 1.0f;
  s_gamma = 0.0f;
  s_out_low = 0.0f; s_out_high = 1.0f;
  s_initialized = false;

  state::init("video.levels", {1, 0, 0},
    state::Schema()
      .floatField("in_low",   0.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("in_high",  1.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("gamma",    0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("out_low",  0.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("out_high", 1.0f, 0.f, 1.f, state::SecondaryInput)
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
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "in_low"))   s_in_low   = state::patchFloat(i);
    else if (state::pathIs(p, l, "in_high"))  s_in_high  = state::patchFloat(i);
    else if (state::pathIs(p, l, "gamma"))    s_gamma    = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_low"))  s_out_low  = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_high")) s_out_high = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  Uniforms u = {};
  u.in_low = s_in_low;
  u.in_high = s_in_high;
  u.gamma_exp = std::pow(2.0f, -s_gamma * 3.0f);  // -1 → 8, 0 → 1, +1 → 1/8
  u.out_low = s_out_low;
  u.out_high = s_out_high;
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

} // namespace levels
