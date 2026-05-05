/*
 * video.sharpen — Laplacian sharpen.
 *
 *   out = in + amount * (5 * center - up - down - left - right)
 *
 * The kernel is 5 taps. `amount` 0..1 maps perceptually to the Laplacian
 * gain. `radius` scales the tap spacing so heavier sharpens can pull
 * structure from larger neighbourhoods.
 */

#include <gpu.h>
#include <host.h>
#include "sharpen_shaders.h"

namespace sharpen {

struct Uniforms {
  float amount;
  float radius_px;
  float _pad[2];
};

static float s_amount = 0.4f;
static float s_radius = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_amount = 0.4f;
  s_radius = 0.0f;
  s_initialized = false;

  state::init("video.sharpen", {1, 0, 0},
    state::Schema()
      .floatField("amount", 0.4f, 0.f, 1.f, state::PrimaryInput)
      .floatField("radius", 0.0f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "amount")) s_amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius")) s_radius = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  // radius=0 → 1px (classic sharpen). radius=1 → ~2.5% of viewport min dim.
  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  float radius_px = 1.0f + s_radius * (static_cast<float>(min_dim) * 0.025f);

  Uniforms u = { s_amount, radius_px, {0, 0} };
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

} // namespace sharpen
