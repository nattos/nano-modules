/*
 * color.tone.curve — Power curve applied to RGB and alpha.
 *
 * Per the style guide, exposed as a normalized signed slider. The
 * parameter feeds an exponential mapping so the perceived effect is
 * symmetric and continuous around 0.
 *
 *   slider -1.0  →  exponent 8.0       (heavy downward squash)
 *   slider  0.0  →  exponent 1.0       (identity)
 *   slider +1.0  →  exponent 1.0/8.0   (heavy upward squash)
 *
 * Two independent sliders for RGB and alpha so colour and matte can be
 * shaped separately.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "curve_shaders.h"

namespace curve {

struct FuseUniforms {
  float rgb_exp;
  float alpha_exp;
  float _pad0;
  float _pad1;
};

// Per-instance state. One per chain entry.
struct State {
  float rgb_curve = 0.0f;
  float alpha_curve = 0.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {
    fx::signedSliderToExp(s->rgb_curve),
    fx::signedSliderToExp(s->alpha_curve),
    0.f, 0.f,
  };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.tone.curve", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Curve\n"
        "A single-slider power curve for reshaping tone. Negative values squash "
        "toward black (darker mids), positive values lift toward white (brighter "
        "mids); **0 is identity**. Colour and matte have independent sliders so you "
        "can bend one without touching the other.\n\n"
        "**Try:** a small positive *RGB* to open up shadows without blowing "
        "highlights; shape *Alpha* alone to feather or harden a matte's edge "
        "falloff while leaving colour untouched.")
      .group("curve", "Curve")
        .groupHelp(
          "Both sliders are symmetric around 0 and feed an exponential exponent, so "
          "the perceived push feels even in either direction. *RGB* bends the colour "
          "channels together; *Alpha* bends the matte's transparency ramp — handy "
          "for tightening or softening composited edges.")
      .floatField("rgb",   0.0f, -1.f, 1.f, state::PrimaryInput).label("RGB Curve", "RGB")
      .floatField("alpha", 0.0f, -1.f, 1.f, state::PrimaryInput).label("Alpha Curve", "Alpha")
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1).uniform(2));
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
  s->rgb_curve = 0.0f;
  s->alpha_curve = 0.0f;
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
    if (state::pathIs(pb + off[i], len[i], "rgb"))
      s->rgb_curve = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "alpha"))
      s->alpha_curve = state::patchFloat(i);
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

} // namespace curve
