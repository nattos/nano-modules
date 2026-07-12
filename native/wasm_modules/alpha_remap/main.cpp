/*
 * color.alpha.remap — Alpha Remap.
 *
 * mod.shaper.remap, but for the alpha channel of an image instead of a scalar
 * modulation signal: every pixel's alpha goes through the same range remapper
 * (input window -> ease-in -> ease-out -> output window -> scale) that a wire's
 * "remap" option and the Remap shaper use. So the knobs you already know for
 * bending a modulation curve now bend a matte: lift a soft key's floor, gamma a
 * feathered edge, invert coverage (out_max below out_min), or hard-clip a
 * nearly-binary matte into an actually-binary one.
 *
 * The curve math lives in pixel.hlsl as a hand-port of tap_mod::applyTapMod — a
 * shader can't include the C++ header, so that file is the one place the two
 * have to be kept in step (see its header comment).
 *
 * Class-like instance model: module_init() sets up the type-shared compute PSO +
 * schema once; each chain entry gets its own State (params + uniform buffer) via
 * create(). Registered as a per-pixel fusion mapper, so the chain compiler can
 * fold it into a neighbouring pass instead of paying a dispatch.
 */

#include <gpu.h>
#include <host.h>
#include "alpha_remap_shaders.h"

namespace alpha_remap {

// Mirrors pixel.hlsl's FuseUniforms exactly (12 floats = 48B, 16B-aligned).
struct FuseUniforms {
  float in_min;
  float in_max;
  float out_min;
  float out_max;
  float curve_in;
  float curve_out;
  float exponent;
  float do_saturate;
  float scale;
  float _pad0;
  float _pad1;
  float _pad2;
};

// Per-instance state. One per chain entry. Mirrors the schema field-for-field.
struct State {
  float in_min    = 0.0f;
  float in_max    = 1.0f;
  float out_min   = 0.0f;
  float out_max   = 1.0f;
  int   curve_in  = 0;   // tap_mod::Curve order: 0 lin, 1 quad, 2 circ, 3 pow, 4 fold
  int   curve_out = 0;
  float exponent  = 2.0f;
  bool  saturate  = false;
  float scale     = 1.0f;
  bool  initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {
    s->in_min, s->in_max, s->out_min, s->out_max,
    (float)s->curve_in, (float)s->curve_out,
    s->exponent, s->saturate ? 1.0f : 0.0f, s->scale,
    0.f, 0.f, 0.f,
  };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.alpha.remap", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Alpha Remap\n"
        "Reshapes the **alpha channel** with the same curves a wire's *remap* option "
        "uses on a modulation signal — an input window is rescaled onto an output "
        "window and the response is bent by ease curves. RGB is left alone.\n\n"
        "**Try:** narrow the *Input Range* to steepen a soft key into a firm matte, "
        "flip the *Output Range* (max below min) to invert coverage, raise *Out Min* "
        "to keep a floor of opacity everywhere, or add a *Power* curve to eat into "
        "(or fatten) a feathered edge.")
      // --- Input range: the alpha window mapped onto [0,1] before shaping ---
      .group("input", "Input Range")
        .groupHelp(
          "The slice of incoming alpha the curves act on. Alpha at *In Min* maps to "
          "the bottom of the response and *In Max* to the top, so narrowing the "
          "window makes the remap act over a smaller band of coverage — that's how "
          "you turn a soft, feathered edge into a hard one.")
      .floatField("in_min", 0.0f, 0.f, 1.f, state::PrimaryInput).label("In Min", "InMin")
      .floatField("in_max", 1.0f, 0.f, 1.f, state::PrimaryInput).label("In Max", "InMax")
      // --- Output range: the window the shaped [0,1] is mapped onto ---
      .group("output", "Output Range")
        .groupHelp(
          "The opacity window the shaped alpha lands in. Raise *Out Min* for a floor "
          "of opacity in fully-transparent areas, lower *Out Max* to cap the most "
          "opaque ones, or put *Out Max* below *Out Min* to invert the matte.")
      .floatField("out_min", 0.0f, 0.f, 1.f, state::PrimaryInput).label("Out Min", "OutMin")
      .floatField("out_max", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Out Max", "OutMax")
      // --- Curves & tuning: ease shaping, power exponent, clip, post-scale ---
      .group("curves", "Curves & Tuning")
        .groupHelp(
          "Bend the linear map into a curve. *Curve In* and *Curve Out* apply ease-in "
          "and ease-out shaping (the *Power* curve reads *Exponent*). *Saturate* "
          "hard-clips alpha that falls outside the input window, and *Scale* "
          "multiplies the result last.")
      .selectField("curve_in", 0, state::PrimaryInput,
                   {{"Linear", 0}, {"Quad", 1}, {"Circular", 2},
                    {"Power", 3}, {"Foldback", 4}}, /*wrap=*/true).label("Curve In", "CrvIn")
      .selectField("curve_out", 0, state::PrimaryInput,
                   {{"Linear", 0}, {"Quad", 1}, {"Circular", 2},
                    {"Power", 3}, {"Foldback", 4}}, /*wrap=*/true).label("Curve Out", "CrvOut")
      .floatField("exponent", 2.0f, 0.25f, 8.f, state::SecondaryInput).label("Exponent", "Exp")
      .boolField("saturate", false, state::SecondaryInput).label("Saturate", "Sat")
      .floatField("scale", 1.0f, 0.f, 2.f, state::SecondaryInput).label("Scale", "Scale")
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main",
                                        gpu::Bindings().tex2d(0).storageTex2d(1).uniform(2));
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
  auto buf = s->uniform_buf;   // survives the defaults reset below
  *s = State{};
  s->uniform_buf = buf;
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
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "in_min"))    s->in_min    = state::patchFloat(i);
    else if (state::pathIs(p, l, "in_max"))    s->in_max    = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_min"))   s->out_min   = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_max"))   s->out_max   = state::patchFloat(i);
    else if (state::pathIs(p, l, "curve_in"))  s->curve_in  = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "curve_out")) s->curve_out = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "exponent"))  s->exponent  = state::patchFloat(i);
    else if (state::pathIs(p, l, "saturate"))  s->saturate  = state::patchFloat(i) > 0.5f;
    else if (state::pathIs(p, l, "scale"))     s->scale     = state::patchFloat(i);
  }
}

// Identity when the remap is the identity map: unit windows, linear curves, unit
// scale. Pure function of state, and the effect is stateless — both halves of the
// is_identity contract hold.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return 0;
  return (s->in_min == 0.0f && s->in_max == 1.0f &&
          s->out_min == 0.0f && s->out_max == 1.0f &&
          s->curve_in == 0 && s->curve_out == 0 &&
          s->scale == 1.0f) ? 1 : 0;
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

} // namespace alpha_remap
