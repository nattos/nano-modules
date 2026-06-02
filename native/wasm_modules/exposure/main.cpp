/*
 * video.exposure — Multiplicative gain controlled by a normalized "stops"
 * slider.
 *
 *   slider -1.0  →  -3 stops  (gain = 1/8)
 *   slider  0.0  →   0 stops  (gain = 1)
 *   slider +1.0  →  +3 stops  (gain = 8)
 *
 * Per the style guide, the parameter is normalized [-1, 1] and the
 * exponential mapping happens inside the host. Output is multiplied
 * straight in linear-ish RGB; if you need clean highlight roll-off,
 * pair this with `levels` or a tonemapping effect downstream.
 *
 * `tint_warmth` shifts the gain toward warm/cool, scaled by `tint_amount`
 * so a clean exposure adjustment with `tint_amount = 0` is unaffected.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "exposure_shaders.h"

namespace exposure {

struct FuseUniforms {
  float gain_r, gain_g, gain_b;
  float _pad;
};

// Per-instance state. One per chain entry.
struct State {
  float amount = 0.0f;
  float tint_warmth = 0.0f;
  float tint_amount = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  // exposure: ±3 stops via the shared helper.
  float gain = fx::stops(s->amount);
  // tint: simple R/B push, biased by warmth in [-1, +1].
  // warmth = +1 → boost R, cut B. warmth = -1 → boost B, cut R.
  float wr = 1.0f + s->tint_warmth * s->tint_amount * 0.5f;
  float wg = 1.0f;
  float wb = 1.0f - s->tint_warmth * s->tint_amount * 0.5f;
  FuseUniforms u = { gain * wr, gain * wg, gain * wb, 0.0f };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("video.exposure", {1, 0, 0},
    state::Schema()
      .floatField("amount",      0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("tint_warmth", 0.0f, -1.f, 1.f, state::SecondaryInput)
      .floatField("tint_amount", 0.0f,  0.f, 1.f, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
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
  s->amount = 0.0f;
  s->tint_warmth = 0.0f;
  s->tint_amount = 0.0f;
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

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "amount"))
      s->amount = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "tint_warmth"))
      s->tint_warmth = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "tint_amount"))
      s->tint_amount = state::patchFloat(i);
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

} // namespace exposure
