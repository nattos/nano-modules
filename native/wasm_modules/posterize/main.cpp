/*
 * video.posterize — Quantize RGB to a small number of discrete levels.
 *
 * `amount` is a normalized intensity slider:
 *   0.0  → 256 levels  (passthrough)
 *   1.0  → 2 levels    (heavy posterization)
 * The mapping is exponential so the slider's perceived effect is
 * roughly linear.
 *
 * `quantize_alpha` opts the alpha channel into the same quantization.
 */

#include <gpu.h>
#include <host.h>
#include "posterize_shaders.h"

#include <algorithm>
#include <cmath>

namespace posterize {

struct FuseUniforms {
  float levels;
  float quantize_alpha;
  float _pad0;
  float _pad1;
};

static float s_amount = 0.5f;
static bool s_quantize_alpha = false;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

static float amount_to_levels(float amount) {
  // exponential: 256 ^ (1 - amount). amount=0 → 256, amount=1 → 1, clamped.
  amount = std::min(std::max(amount, 0.0f), 1.0f);
  float lv = std::pow(256.0f, 1.0f - amount);
  return std::max(2.0f, std::round(lv));
}

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {
    amount_to_levels(s_amount),
    s_quantize_alpha ? 1.0f : 0.0f,
    0.f, 0.f,
  };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_amount = 0.5f;
  s_quantize_alpha = false;
  s_initialized = false;

  state::init("video.posterize", {1, 0, 0},
    state::Schema()
      .floatField("amount", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .boolField("quantize_alpha", false, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  state::registerFusion(state::FusionKind::PerPixelMapper,
                        PIXEL_WGSL, PIXEL_MSL,
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
    else if (state::pathIs(pb + off[i], len[i], "quantize_alpha"))
      s_quantize_alpha = state::patchFloat(i) > 0.5f;
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

} // namespace posterize
