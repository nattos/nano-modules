/*
 * video.blend — Blends two texture inputs.
 *
 * output = A * (1 - opacity) + B * opacity
 *
 * Parameters:
 *   0: Opacity (Standard, default 0.5)
 *
 * Texture I/O:
 *   Input 0: Texture A
 *   Input 1: Texture B
 *   Output 0: Blended result
 */

#include <gpu.h>
#include <host.h>
#include "video_blend_shaders.h"

struct Uniforms {
  float opacity;
  float _pad0, _pad1, _pad2;
};

static float s_opacity = 0.5f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_opacity = 0.5f;
  s_initialized = false;

  state::init("com.nattos.video_blend", {1, 0, 0},
    state::Schema()
      .floatField("opacity", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_a", state::PrimaryInput)
      .textureField("tex_b", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto mod = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!mod) return;

  s_pso = gpu::Device::createComputePSO(mod, metal ? "main_" : "main");
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
  state::log("blend: init");
}

__attribute__((export_name("tick")))
void tick(double dt) { (void)dt; }

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) {
  if (index == 0) s_opacity = static_cast<float>(value);
}

__attribute__((export_name("on_state_changed")))
void on_state_changed() {}

__attribute__((export_name("render")))
void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto inputA = gpu::Device::inputTexture(0);
  auto inputB = gpu::Device::inputTexture(1);
  auto output = gpu::Device::renderTarget();

  if (!inputA.valid() || !inputB.valid()) return;

  Uniforms u = { s_opacity, 0, 0, 0 };
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(inputA, 0, 0);  // slot 0, read
  cp.setTexture(inputB, 1, 0);  // slot 1, read
  cp.setTexture(output, 2, 1);  // slot 2, write
  cp.setBuffer(s_uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // extern "C"
