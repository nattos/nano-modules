/*
 * Brightness/Contrast — GPU compute effect module.
 *
 * Takes a texture input, applies brightness and contrast adjustments,
 * outputs to the render target.
 *
 * Parameters:
 *   0: Brightness (float 0-1, default 0.5 = neutral)
 *   1: Contrast   (float 0-1, default 0.5 = neutral / 1x)
 */

#include <gpu.h>
#include <host.h>
#include <io.h>
#include "brightness_contrast_shaders.h"

#include <cmath>

struct Uniforms {
  float brightness;
  float contrast;
  float _pad[2];
};

// --- State ---

static float s_brightness = 0.5f;
static float s_contrast = 0.5f;
static bool s_initialized = false;

static gpu::ComputePSO s_compute_pso;
static gpu::Buffer s_uniform_buf;

// --- Exports ---

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_brightness = 0.5f;
  s_contrast = 0.5f;
  s_initialized = false;

  state::setMetadata("com.nattos.brightness_contrast", {1, 0, 0});
  state::declareParam(0, "Brightness", state::ParamType::Standard, 0.5f);
  state::declareParam(1, "Contrast", state::ParamType::Standard, 0.5f);

  io::declareTextureInput(0, "Input", io::Role::Primary);
  io::declareTextureOutput(0, "Output", io::Role::Primary);

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

__attribute__((export_name("tick")))
void tick(double dt) {
  (void)dt;
}

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == 0) s_brightness = static_cast<float>(value);
  else if (index == 1) s_contrast = static_cast<float>(value);
}

__attribute__((export_name("on_state_changed")))
void on_state_changed() {}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  // Get input texture (injected by sketch executor)
  auto input = gpu::Device::inputTexture(0);
  auto output = gpu::Device::renderTarget();

  if (!input.valid()) {
    // No input texture — nothing to process
    return;
  }

  // Write uniforms
  Uniforms u = { s_brightness, s_contrast, {0, 0} };
  s_uniform_buf.writeOne(u);

  // Compute pass: read input, write output
  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_compute_pso);
  cp.setTexture(input, 0, 0);   // slot 0, read
  cp.setTexture(output, 1, 1);  // slot 1, write
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // extern "C"
