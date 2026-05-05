/*
 * video.hsl — Hue / Saturation / Lightness colour grading.
 *
 *   hue_shift  [-1, +1]  →  ±180° rotation around the colour wheel
 *   saturation [-1, +1]  →  -1 collapses to greyscale, +1 doubles saturation
 *   lightness  [-1, +1]  →  bipolar lift/crush biased toward black/white
 *
 * Hue rotation happens in HSL space so the rotation is uniform across
 * brightness levels — far more useful than a YIQ rotation for live
 * colour-shift performance.
 */

#include <gpu.h>
#include <host.h>
#include "hsl_shaders.h"

namespace hsl {

struct FuseUniforms {
  float hue_shift;   // turns (1.0 == full rotation)
  float saturation;  // [-1, 1]
  float lightness;   // [-1, 1]
  float _pad;
};

static float s_hue = 0.0f;
static float s_sat = 0.0f;
static float s_lit = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  // [-1, 1] slider → [-0.5, +0.5] turns (= ±180°)
  FuseUniforms u = { s_hue * 0.5f, s_sat, s_lit, 0.f };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_hue = 0.0f; s_sat = 0.0f; s_lit = 0.0f;
  s_initialized = false;

  state::init("video.hsl", {1, 0, 0},
    state::Schema()
      .floatField("hue_shift",  0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("saturation", 0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("lightness",  0.0f, -1.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s_uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "hue_shift"))  s_hue = state::patchFloat(i);
    else if (state::pathIs(p, l, "saturation")) s_sat = state::patchFloat(i);
    else if (state::pathIs(p, l, "lightness"))  s_lit = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace hsl
