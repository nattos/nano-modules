/*
 * color.colorize — Tint the whole frame toward a single colour.
 *
 * Standard params:
 *   color        rgb        the tint.
 *   amount       [0, 1]     cross-fade from the original to the tinted image.
 *                           0 = no-op.
 *   mode         select     Luma (replace chroma, keep brightness — the classic
 *                           colorize), Multiply (a gel: darkens, keeps chroma),
 *                           Screen (a wash of light: lifts, never darkens).
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "colorize_shaders.h"

namespace colorize {

enum Mode { ModeLuma = 0, ModeMultiply = 1, ModeScreen = 2 };

// Layout MUST match `struct FuseUniforms` in pixel.hlsl.
struct FuseUniforms {
  float r, g, b;
  float amount;
  float mode;
  float _pad0, _pad1, _pad2;
};

// Per-instance state. One per chain entry.
struct State {
  float r = 1.0f, g = 0.55f, b = 0.2f;
  float amount = 1.0f;
  int mode = ModeLuma;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s->r, s->g, s->b, s->amount,
                     static_cast<float>(s->mode), 0.f, 0.f, 0.f };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.colorize", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Colorize\n"
        "Pushes the whole frame toward one colour. *Luma* is the classic colorize — "
        "it throws away the original chroma and keeps only the brightness, so the "
        "image becomes a monochrome print in your colour (a white *Colour* gives you "
        "plain greyscale). *Multiply* behaves like a gel over the lens: it keeps the "
        "original hues and only darkens. *Screen* is the opposite, a wash of light "
        "that lifts without ever darkening.\n\n"
        "**Try:** a warm *Luma* tint for sepia, a deep blue one for day-for-night, or "
        "a low *Amount* in *Screen* to fog the shadows. Wire *Colour* to a rail to "
        "cycle the whole look.")
      .group("colorize", "Colorize")
        .groupHelp(
          "*Colour* is the tint; *Amount* cross-fades from the untouched image to the "
          "fully tinted one; *Mode* picks how the tint is applied.")
      .rgbField("color", 1.0f, 0.55f, 0.2f, state::PrimaryInput).label("Colour", "Color")
      .floatField("amount", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Amount", "Amt")
      .selectField("mode", ModeLuma, state::SecondaryInput,
                   {{"Luma", ModeLuma}, {"Multiply", ModeMultiply}, {"Screen", ModeScreen}})
        .label("Mode", "Mode")
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
  s->r = 1.0f; s->g = 0.55f; s->b = 0.2f;
  s->amount = 1.0f;
  s->mode = ModeLuma;
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

// Passthrough at amount == 0 in every mode (the cross-fade keeps the original).
// Stateless — skippable, and the fused group collapses if every stage is identity.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->amount == 0.0f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "amount")) s->amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "mode"))   s->mode   = state::patchInt(i);
    else if (state::pathIs(p, l, "color")) {
      auto v = state::patchVec3(i);
      s->r = v.x; s->g = v.y; s->b = v.z;
    }
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

} // namespace colorize
