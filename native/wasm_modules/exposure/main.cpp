/*
 * video.exposure — Multiplicative gain controlled by a normalized "stops"
 * slider.
 *
 *   slider -1.0  →  -3 stops  (gain = 1/8)
 *   slider  0.0  →   0 stops  (gain = 1)
 *   slider +1.0  →  +3 stops  (gain = 8)
 *
 * Per the style guide, the parameter is normalized [-1, 1] and the
 * exponential mapping happens inside the host. Output is multiplied
 * straight in linear-ish RGB; if you need clean highlight roll-off,
 * pair this with `levels` or a tonemapping effect downstream.
 *
 * `tint_warmth` shifts the gain toward warm/cool, scaled by `tint_amount`
 * so a clean exposure adjustment with `tint_amount = 0` is unaffected.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "exposure_shaders.h"

namespace exposure {

struct Uniforms {
  float gain_r, gain_g, gain_b;
  float _pad;
};

static float s_amount = 0.0f;
static float s_tint_warmth = 0.0f;
static float s_tint_amount = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_amount = 0.0f;
  s_tint_warmth = 0.0f;
  s_tint_amount = 0.0f;
  s_initialized = false;

  state::init("video.exposure", {1, 0, 0},
    state::Schema()
      .floatField("amount",      0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("tint_warmth", 0.0f, -1.f, 1.f, state::SecondaryInput)
      .floatField("tint_amount", 0.0f,  0.f, 1.f, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "amount"))
      s_amount = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "tint_warmth"))
      s_tint_warmth = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "tint_amount"))
      s_tint_amount = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  // exposure: ±3 stops via the shared helper.
  float gain = fx::stops(s_amount);
  // tint: simple R/B push, biased by warmth in [-1, +1].
  // warmth = +1 → boost R, cut B. warmth = -1 → boost B, cut R. Centred at 0.
  float wr = 1.0f + s_tint_warmth * s_tint_amount * 0.5f;
  float wg = 1.0f;  // green stays neutral — leave colour-balance ratio to a real CC effect later
  float wb = 1.0f - s_tint_warmth * s_tint_amount * 0.5f;

  Uniforms u = { gain * wr, gain * wg, gain * wb, 0.0f };
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

} // namespace exposure
