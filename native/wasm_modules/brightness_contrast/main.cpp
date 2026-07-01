/*
 * Brightness & Contrast — fusion-aware GPU compute effect.
 * Per-pixel logic in pixel.hlsl. See EFFECTS_STYLE_GUIDE.md §0.1.
 *
 * Class-like instance model: module_init() sets up the type-shared
 * compute PSO + schema once; each chain entry gets its own State (params
 * + uniform buffer) via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "brightness_contrast_shaders.h"

#include <cmath>

namespace brightness_contrast {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl.
struct FuseUniforms {
  float brightness;
  float contrast;
  float _pad0;
  float _pad1;
};

// Per-instance state. One per chain entry. Both params are signed with 0 as
// the neutral point: brightness shifts by [-1,+1], contrast scales by
// (contrast+1) ∈ [0,2] (1× at 0). See pixel.hlsl.
struct State {
  float brightness = 0.f;
  float contrast = 0.f;
  bool initialized = false;
  gpu::Buffer uniform_buf;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_compute_pso;

void prepare(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s->brightness, s->contrast, 0.f, 0.f };
  s->uniform_buf.writeOne(u);
}

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("color.tone.brightness_contrast", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Brightness & Contrast\n"
        "The classic two-knob tone tweak. *Brightness* lifts or drops the whole "
        "image; *Contrast* pushes tones away from (or toward) mid-grey. Both are "
        "signed with **0 as neutral**, so the effect is a free passthrough when "
        "untouched.\n\n"
        "**Try:** a touch of positive contrast with a hair of negative brightness "
        "for a punchier, slightly moodier grade; pull contrast negative to flatten "
        "an image before stacking a stronger look on top.")
      .group("tone", "Tone")
      .floatField("brightness", 0.f, -1.f, 1.f, state::PrimaryInput).label("Brightness", "Bright")
      .floatField("contrast", 0.f, -1.f, 1.f, state::PrimaryInput).label("Contrast", "Cntrst")
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) {
    state::log(state::LogLevel::Error, "BrightnessContrast: no GPU backend");
    return;
  }

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs_mod = gpu::Device::createShaderModuleByName("compute");
  if (!cs_mod) {
    state::log(state::LogLevel::Error, "BrightnessContrast: shader compile failed");
    return;
  }

  s_compute_pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  state::log("BrightnessContrast: module initialized");
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
  s->brightness = 0.f;
  s->contrast = 0.f;
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


// Passthrough at neutral: pixel.hlsl shifts by brightness and scales by
// (contrast+1), so brightness == 0 (no shift) AND contrast == 0 (1× scale)
// ⇒ out == in (the trailing saturate is a no-op on the already-[0,1] input).
// Stateless — the executor skips this stage and, if its whole fused group is
// identity, the group's dispatch entirely.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->brightness == 0.f && s->contrast == 0.f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "brightness"))
      s->brightness = state::patchFloat(i);
    else if (state::pathIs(pb + off[i], len[i], "contrast"))
      s->contrast = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");

  if (!input.valid()) return;
  if (!output.valid()) {
    // Fallback to legacy API
    output = gpu::Device::renderTarget();
    input = gpu::Device::inputTexture(0);
    if (!input.valid()) return;
  }

  prepare(self, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_compute_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace brightness_contrast
