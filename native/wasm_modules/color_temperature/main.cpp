/*
 * color.temperature — Warm/cool white-balance shift.
 *
 *   temperature -1.0  →  cool  (boost B, cut R)
 *   temperature  0.0  →  neutral (pass-through)
 *   temperature +1.0  →  warm  (boost R, cut B)
 *
 * A simple per-channel multiply on the orange/blue axis. Split out of
 * `color.tone.exposure` so exposure stays a clean stops-only gain. Pair with
 * `exposure` upstream/downstream if you want both.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "color_temperature_shaders.h"

namespace color_temperature {

struct FuseUniforms {
  float mul_r, mul_g, mul_b;
  float _pad;
};

// Per-instance state. One per chain entry.
struct State {
  float temperature = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  // warm = +1 → boost R, cut B. cool = -1 → boost B, cut R. Max ±0.5 push.
  float mr = 1.0f + s->temperature * 0.5f;
  float mg = 1.0f;
  float mb = 1.0f - s->temperature * 0.5f;
  FuseUniforms u = { mr, mg, mb, 0.0f };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.temperature", {1, 0, 0},
    state::Schema()
      .floatField("temperature", 0.0f, -1.f, 1.f, state::PrimaryInput)
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
  s->temperature = 0.0f;
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


// Passthrough at neutral: temperature == 0 ⇒ all multipliers 1× ⇒ out == in.
// Stateless — skippable, and the fused group collapses if every stage is identity.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->temperature == 0.0f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "temperature"))
      s->temperature = state::patchFloat(i);
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

} // namespace color_temperature
