/*
 * video.vibrance — Saturation boost biased toward already-unsaturated pixels.
 *
 * Standard saturation pulls every pixel uniformly, which pushes already
 * saturated areas (skin tones, overdriven LEDs) into oversaturated mush.
 * Vibrance applies a saturation curve that's strong on grey-ish pixels
 * and gentle on already-saturated ones.
 *
 *   amount > 0  →  raises saturation, weighted by (1 - sat)
 *   amount < 0  →  lowers saturation, weighted by sat (so already-grey stays grey)
 */

#include <gpu.h>
#include <host.h>
#include "vibrance_shaders.h"

namespace vibrance {

struct FuseUniforms {
  float amount;
  float _pad0;
  float _pad1;
  float _pad2;
};

static float s_amount = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s_amount, 0.f, 0.f, 0.f };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_amount = 0.0f;
  s_initialized = false;

  state::init("video.vibrance", {1, 0, 0},
    state::Schema()
      .floatField("amount", 0.0f, -1.f, 1.f, state::PrimaryInput)
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
    if (state::pathIs(pb + off[i], len[i], "amount"))
      s_amount = state::patchFloat(i);
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

} // namespace vibrance
