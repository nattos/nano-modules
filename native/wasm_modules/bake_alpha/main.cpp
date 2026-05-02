/*
 * video.bake_alpha — Premultiply a texture's RGB by its alpha.
 *
 * Useful when feeding a straight-alpha texture into a downstream effect
 * that assumes premultiplied input. With amount = 1.0 the result is
 * fully premultiplied; with amount = 0.0 the input passes through
 * unchanged.
 */

#include <gpu.h>
#include <host.h>
#include "bake_alpha_shaders.h"

namespace bake_alpha {

struct Uniforms {
  float amount;
  float _pad[3];
};

static float s_amount = 1.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_amount = 1.0f;
  s_initialized = false;

  state::init("video.bake_alpha", {1, 0, 0},
    state::Schema()
      .floatField("amount", 1.0f, 0.f, 1.f, state::PrimaryInput)
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
    if (state::pathIs(pb + off[i], len[i], "amount"))
      s_amount = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  Uniforms u = { s_amount, {0, 0, 0} };
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

} // namespace bake_alpha
