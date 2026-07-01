/*
 * filter.blur.gaussian — Thin wrapper around `fx::GaussianBlur`.
 *
 * The actual blur machinery lives in `<effect_blur.h>` so it can be
 * reused by future effects (bloom, glow, depth-of-field, soft shadows,
 * any "less local" operation). This file just owns the schema, plumbs
 * the two playable params, and delegates to the utility.
 *
 * Class-like instance model: module_init() publishes the schema +
 * backend check once per type; each chain entry gets its own State
 * (params + its own fx::GaussianBlur helper, which owns the PSO and all
 * per-instance GPU scratch) via create(). All instance callbacks take
 * `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_blur.h>

namespace blur {

// Per-instance state. One per chain entry. Holds the params and the
// GaussianBlur helper BY VALUE — the helper owns the compiled PSO and all
// per-instance GPU scratch (uniform/weights buffers + the lazy scratch
// texture).
struct State {
  fx::GaussianBlur blur;
  float radius = 0.25f;
  float quality = 1.0f;
  bool initialized = false;
};

// Type-level setup: publish the schema + backend check once per type.
void module_init() {
  state::init("filter.blur.gaussian", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Gaussian Blur\n"
        "A clean, true Gaussian softening of the incoming image. *Radius* sets "
        "how far the blur spreads; *Quality* trades speed for smoothness.\n\n"
        "**Try:** a tiny radius to knock off aliasing, or push it wide and mix "
        "the result back with a *composite* for a soft bloom/glow base.")
      .group("blur", "Blur")
        .groupHelp(
          "*Radius* is the softening amount — small values clean up edges, large "
          "values dissolve the picture into colour fields. Drop *Quality* if you "
          "need the speed; the difference only shows at large radii.")
      .floatField("radius",  0.25f, 0.f, 1.f, state::PrimaryInput).label("Radius", "Rad")
      .floatField("quality", 1.0f,  0.f, 1.f, state::PrimaryInput).label("Quality", "Qual")
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;
}

// Per-instance construction. The helper's GPU resources (PSO + buffers)
// are allocated in init() via blur.init(), which is idempotent.
void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

// Per-instance init tail: defaults + allocate the helper's GPU resources.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->radius = 0.25f;
  s->quality = 1.0f;

  s->blur.init();
  if (!s->blur.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) { (void)self; (void)dt; }


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "radius"))  s->radius  = state::patchFloat(i);
    else if (state::pathIs(p, l, "quality")) s->quality = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->blur.valid() || vp_w <= 0 || vp_h <= 0) return;
  auto input  = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;
  s->blur.applyWithRadius(input, output, vp_w, vp_h, s->radius, s->quality);
  gpu::Device::submit();
}

} // namespace blur
