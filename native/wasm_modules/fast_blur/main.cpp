/*
 * filter.blur.fast — Thin wrapper around `fx::FastBlur`.
 *
 * The actual blur machinery lives in `<effect_fast_blur.h>` so it can
 * be reused by future effects (bloom, glow, depth-of-field, energy
 * diffusion, anything wanting a wide soft blur cheap). This file just
 * owns the schema, plumbs the iterations param, and delegates.
 *
 * Class-like instance model: module_init() publishes the schema +
 * backend check once per type; each chain entry gets its own State
 * (params + its own fx::FastBlur helper, which owns the per-instance
 * multi-mip scratch pyramid) via create(). All instance callbacks take
 * `self`.
 */

#include <gpu.h>
#include <host.h>
#include <effect_fast_blur.h>

namespace fast_blur {

// Per-instance state. One per chain entry.
//
// fx::FastBlur lives BY VALUE here: it owns the per-instance multi-mip
// scratch pyramid (lazily (re)allocated on resolution change) plus its
// per-instance uniform buffers + sampler. Its init() is a single
// idempotent setup() that ALSO (re)registers the down/up shaders and
// builds the down/up PSOs — there is no split between the type-shared
// PSO build and the per-instance scratch allocation — so the helper
// stays in State and we call its init() per-instance, exactly as the
// old code did. (See report for the multi-instance caveat.)
struct State {
  fx::FastBlur blur;
  int  iterations  = 4;
  bool initialized = false;
};

// Type-level setup: schema + backend check. Runs once per type.
void module_init() {
  state::init("filter.blur.fast", {1, 0, 0},
    state::Schema()
      .intField("iterations", 4, 1, fx::FastBlur::MAX_ITERATIONS, state::PrimaryInput)
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;
  state::log("fast_blur: module initialized");
}

// Per-instance construction: allocate State. The helper's GPU resources
// are set up in init(); its scratch pyramid is allocated lazily on the
// first apply().
void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  // fx::FastBlur has no explicit release method; its GPU resources are
  // owned by value and torn down with the State.
  delete s;
}

// Per-instance init tail: defaults + helper setup. Guards readiness.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->iterations = 4;
  if (!s->blur.init()) return;
  s->initialized = true;
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "iterations")) {
      s->iterations = (int)state::patchFloat(i);
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->blur.valid() || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  s->blur.apply(in, out, vp_w, vp_h, s->iterations);
  gpu::Device::submit();
}

} // namespace fast_blur
