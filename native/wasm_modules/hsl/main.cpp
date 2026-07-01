/*
 * color.hsl — Hue / Saturation / Lightness colour grading.
 *
 *   hue_shift  [-1, +1]  →  ±180° rotation around the colour wheel
 *   saturation [-1, +1]  →  -1 collapses to greyscale, +1 doubles saturation
 *   lightness  [-1, +1]  →  bipolar lift/crush biased toward black/white
 *
 * Hue rotation happens in HSL space so the rotation is uniform across
 * brightness levels — far more useful than a YIQ rotation for live
 * colour-shift performance.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "hsl_shaders.h"

namespace hsl {

struct FuseUniforms {
  float hue_shift;   // turns (1.0 == full rotation)
  float saturation;  // [-1, 1]
  float lightness;   // [-1, 1]
  float _pad;
};

// Per-instance state. One per chain entry.
struct State {
  float hue = 0.0f;
  float sat = 0.0f;
  float lit = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  // [-1, 1] slider → [-0.5, +0.5] turns (= ±180°)
  FuseUniforms u = { s->hue * 0.5f, s->sat, s->lit, 0.f };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.hsl", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## HSL\n"
        "Hue / Saturation / Lightness grading in HSL space, so the hue rotation is "
        "uniform across brightness levels. *Hue Shift* spins the whole colour wheel "
        "(±1 = ±180°); *Saturation* runs from greyscale (−1) through neutral (0) to "
        "doubled (+1); *Lightness* lifts toward white or crushes toward black.\n\n"
        "**Try:** a slow *Hue Shift* automation for a psychedelic cycle, or pull "
        "*Saturation* to −1 for an instant black-and-white pass.")
      .group("hsl", "Hue / Sat / Light")
      .floatField("hue_shift",  0.0f, -1.f, 1.f, state::PrimaryInput).label("Hue Shift", "Hue")
      .floatField("saturation", 0.0f, -1.f, 1.f, state::PrimaryInput).label("Saturation", "Sat")
      .floatField("lightness",  0.0f, -1.f, 1.f, state::PrimaryInput).label("Lightness", "Light")
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
  s->hue = 0.0f; s->sat = 0.0f; s->lit = 0.0f;
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
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "hue_shift"))  s->hue = state::patchFloat(i);
    else if (state::pathIs(p, l, "saturation")) s->sat = state::patchFloat(i);
    else if (state::pathIs(p, l, "lightness"))  s->lit = state::patchFloat(i);
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

} // namespace hsl
