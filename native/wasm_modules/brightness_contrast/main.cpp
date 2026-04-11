/*
 * Brightness/Contrast — GPU compute effect module.
 *
 * Takes a texture input, applies brightness and contrast adjustments,
 * outputs to render target.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "brightness_contrast_shaders.h"

#include <cmath>

namespace brightness_contrast {

struct Uniforms {
  float brightness;
  float contrast;
  float _pad[2];
};

static float s_brightness = 0.5f;
static float s_contrast = 0.5f;
static bool s_initialized = false;

static gpu::ComputePSO s_compute_pso;
static gpu::Buffer s_uniform_buf;

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

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  const char* cs = metal ? COMPUTE_MSL : COMPUTE_WGSL;
  const char* entry = metal ? "main_" : "main";

  auto cs_mod = gpu::Device::createShaderModule(cs);
  if (!cs_mod) {
    state::log(state::LogLevel::Error, "BrightnessContrast: shader compile failed");
    return;
  }

  s_compute_pso = gpu::Device::createComputePSO(cs_mod, entry);
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("BrightnessContrast: initialized");
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

  Uniforms u = { s_brightness, s_contrast, {0, 0} };
  s_uniform_buf.writeOne(u);

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
