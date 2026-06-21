/*
 * color.posterize — Quantize RGB to a small number of discrete levels.
 *
 * `amount` is a normalized intensity slider:
 *   0.0  → 256 levels  (passthrough)
 *   1.0  → 2 levels    (heavy posterization)
 * The mapping is exponential so the slider's perceived effect is
 * roughly linear.
 *
 * `quantize_alpha` opts the alpha channel into the same quantization.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "posterize_shaders.h"

#include <algorithm>
#include <cmath>

namespace posterize {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl.
struct FuseUniforms {
  float levels;
  float quantize_alpha;
  float _pad0;
  float _pad1;
};

// Per-instance state. One per chain entry.
struct State {
  float amount = 0.5f;
  bool quantize_alpha = false;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

static float amount_to_levels(float amount) {
  // exponential: 256 ^ (1 - amount). amount=0 → 256, amount=1 → 1, clamped.
  amount = std::min(std::max(amount, 0.0f), 1.0f);
  float lv = std::pow(256.0f, 1.0f - amount);
  return std::max(2.0f, std::round(lv));
}

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {
    amount_to_levels(s->amount),
    s->quantize_alpha ? 1.0f : 0.0f,
    0.f, 0.f,
  };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.posterize", {1, 0, 0},
    state::Schema()
      .floatField("amount", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .boolField("quantize_alpha", false, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

// Per-instance init tail: defaults + per-instance fusion registration.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->amount = 0.5f;
  s->quantize_alpha = false;
  if (!s->uniform_buf.valid()) return;
  s->initialized = true;

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s->uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(void* self, double dt) {
  (void)self;
  (void)dt;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "amount"))
      s->amount = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "quantize_alpha"))
      s->quantize_alpha = state::patchFloat(i) > 0.5f;
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace posterize
