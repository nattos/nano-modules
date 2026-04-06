/*
 * source.solid_color — Solid color texture generator.
 *
 * Fills the render target with a uniform RGB color.
 *
 * Parameters:
 *   0: Red   (Standard, default 0.5)
 *   1: Green (Standard, default 0.5)
 *   2: Blue  (Standard, default 0.5)
 */

#include <gpu.h>
#include <host.h>
#include "solid_color_shaders.h"

struct Uniforms {
  float r, g, b, _pad;
};

static float s_r = 0.5f, s_g = 0.5f, s_b = 0.5f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_r = 0.5f; s_g = 0.5f; s_b = 0.5f;
  s_initialized = false;

  state::init("com.nattos.solid_color", {1, 0, 0},
    state::Schema()
      .floatField("red", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("green", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("blue", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto mod = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!mod) return;

  s_pso = gpu::Device::createComputePSO(mod, metal ? "main_" : "main");
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

__attribute__((export_name("tick")))
void tick(double dt) { (void)dt; }

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == 0) s_r = static_cast<float>(value);
  else if (index == 1) s_g = static_cast<float>(value);
  else if (index == 2) s_b = static_cast<float>(value);
}

__attribute__((export_name("on_state_changed")))
void on_state_changed() {}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::renderTarget();
  Uniforms u = { s_r, s_g, s_b, 0 };
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(output, 0, 1); // slot 0, write
  cp.setBuffer(s_uniform_buf, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // extern "C"
