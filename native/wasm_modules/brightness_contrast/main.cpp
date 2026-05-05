/*
 * Brightness/Contrast — fusion-aware GPU compute effect.
 * Per-pixel logic in pixel.hlsl. See EFFECTS_STYLE_GUIDE.md §0.1.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "brightness_contrast_shaders.h"

#include <cmath>

namespace brightness_contrast {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl.
struct FuseUniforms {
  float brightness;
  float contrast;
  float _pad0;
  float _pad1;
};

static float s_brightness = 0.5f;
static float s_contrast = 0.5f;
static bool s_initialized = false;

static gpu::ComputePSO s_compute_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s_brightness, s_contrast, 0.f, 0.f };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_brightness = 0.5f;
  s_contrast = 0.5f;
  s_initialized = false;

  state::init("video.brightness_contrast", {1, 0, 0},
    state::Schema()
      .floatField("brightness", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("contrast", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) {
    state::log(state::LogLevel::Error, "BrightnessContrast: no GPU backend");
    return;
  }


  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs_mod = gpu::Device::createShaderModuleByName("compute");
  if (!cs_mod) {
    state::log(state::LogLevel::Error, "BrightnessContrast: shader compile failed");
    return;
  }

  s_compute_pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("BrightnessContrast: initialized");

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s_uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(double dt) {
  (void)dt;
}

void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "brightness"))
      s_brightness = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "contrast"))
      s_contrast = state::patchFloat(i);
  }
}


void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");

  if (!input.valid()) return;
  if (!output.valid()) {
    // Fallback to legacy API
    output = gpu::Device::renderTarget();
    input = gpu::Device::inputTexture(0);
    if (!input.valid()) return;
  }

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_compute_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace brightness_contrast
