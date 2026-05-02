/*
 * video.invert — Color inversion with adjustable amount.
 *
 * `amount` smoothly mixes between input and inverted RGB. Alpha
 * inversion is opt-in via a separate toggle so most uses don't
 * accidentally flip the matte.
 */

#include <gpu.h>
#include <host.h>
#include "invert_shaders.h"

namespace invert {

struct Uniforms {
  float amount;
  float invert_alpha;
  float _pad[2];
};

static float s_amount = 1.0f;
static bool s_invert_alpha = false;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_amount = 1.0f;
  s_invert_alpha = false;
  s_initialized = false;

  state::init("video.invert", {1, 0, 0},
    state::Schema()
      .floatField("amount", 1.0f, 0.f, 1.f, state::PrimaryInput)
      .boolField("invert_alpha", false, state::SecondaryInput)
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
    else if (state::pathIs(pb + off[i], len[i], "invert_alpha"))
      s_invert_alpha = state::patchFloat(i) > 0.5f;
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  Uniforms u = { s_amount, s_invert_alpha ? 1.0f : 0.0f, {0, 0} };
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

} // namespace invert
