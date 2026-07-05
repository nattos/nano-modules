/*
 * color.tone.levels — Photoshop-style input/output remapping with gamma.
 *
 *   x = saturate((in - in_low) / (in_high - in_low))
 *   x = pow(x, gamma_exp)
 *   out = lerp(out_low, out_high, x)
 *
 * `gamma` is normalized [-1, 1] using the same exponential mapping as
 * the `curve` effect: -1 → exp 8 (crush mids dark), 0 → 1 (identity),
 * +1 → exp 1/8 (lift mids bright).
 *
 * Standard params (in_low/in_high/gamma) live up front; the output
 * remap (out_low/out_high) is tuning, since most patches just want
 * input-side adjustment.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "levels_shaders.h"

namespace levels {

struct FuseUniforms {
  float in_low, in_high;
  float gamma_exp;
  float out_low, out_high;
  float _pad0;
  float _pad1;
  float _pad2;
};

// Per-instance state. One per chain entry.
struct State {
  float in_low = 0.0f;
  float in_high = 1.0f;
  float gamma = 0.0f;
  float out_low = 0.0f;
  float out_high = 1.0f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {};
  u.in_low = s->in_low;
  u.in_high = s->in_high;
  u.gamma_exp = fx::signedSliderToExp(s->gamma);
  u.out_low = s->out_low;
  u.out_high = s->out_high;
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.tone.levels", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Levels\n"
        "Photoshop-style input/output remapping with a mid-tone gamma. Set the black "
        "and white *input* points to stretch the used range, bend the mids with "
        "*Gamma*, then optionally compress the result into a narrower *output* range. "
        "It's the workhorse for fixing washed-out or crushed footage.\n\n"
        "**Try:** pull *Input Low* up and *Input High* down to add snap and contrast; "
        "then lift *Output Low* slightly for a faded, filmic 'lifted blacks' look.")
      .group("input", "Input")
        .groupHelp(
          "Everything below *Input Low* becomes black and everything above *Input "
          "High* becomes white, so tightening these two points maximises contrast. "
          "*Gamma* is symmetric around 0: negative crushes mids darker, positive "
          "lifts them brighter, 0 is untouched.")
      .floatField("in_low",   0.0f, 0.f, 1.f, state::PrimaryInput).label("Input Low", "In Lo")
      .floatField("in_high",  1.0f, 0.f, 1.f, state::PrimaryInput).label("Input High", "In Hi")
      .floatField("gamma",    0.0f, -1.f, 1.f, state::PrimaryInput).label("Gamma", "Gamma")
      .group("output", "Output")
        .groupHelp(
          "Remaps the corrected image into a new brightness window — raise *Output "
          "Low* to lift blacks toward grey, or lower *Output High* to hold back "
          "highlights. Most patches leave these at the defaults; reach for them when "
          "matching two shots or building a faded grade.")
      .floatField("out_low",  0.0f, 0.f, 1.f, state::SecondaryInput).label("Output Low", "Out Lo")
      .floatField("out_high", 1.0f, 0.f, 1.f, state::SecondaryInput).label("Output High", "Out Hi")
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
  s->in_low = 0.0f; s->in_high = 1.0f;
  s->gamma = 0.0f;
  s->out_low = 0.0f; s->out_high = 1.0f;
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
    if      (state::pathIs(p, l, "in_low"))   s->in_low   = state::patchFloat(i);
    else if (state::pathIs(p, l, "in_high"))  s->in_high  = state::patchFloat(i);
    else if (state::pathIs(p, l, "gamma"))    s->gamma    = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_low"))  s->out_low  = state::patchFloat(i);
    else if (state::pathIs(p, l, "out_high")) s->out_high = state::patchFloat(i);
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

} // namespace levels
