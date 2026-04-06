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

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_brightness = 0.5f;
  s_contrast = 0.5f;
  s_initialized = false;

  state::init("com.nattos.brightness_contrast", {1, 0, 0},
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

__attribute__((export_name("on_state_patched")))
void on_state_patched(int patch_count,
                       const char* paths_buf,
                       const int* offsets,
                       const int* lengths,
                       const int* ops) {
  for (int i = 0; i < patch_count; i++) {
    const char* path = paths_buf + offsets[i];
    int path_len = lengths[i];
    int op = ops[i];

    if (op != state::PatchReplace) continue;

    // Fetch the patch value via the val system
    int patch_h = state::getPatch(i);
    if (patch_h <= 0) continue;

    int value_h = val::get(patch_h, "value");
    double new_val = val::asNumber(value_h);
    val::release(value_h);
    val::release(patch_h);

    // Match field paths
    if (path_len == 10 && path[0] == 'b') { // "brightness"
      s_brightness = static_cast<float>(new_val);
    } else if (path_len == 8 && path[0] == 'c') { // "contrast"
      s_contrast = static_cast<float>(new_val);
    }
  }
}

__attribute__((export_name("render")))
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

} // extern "C"
