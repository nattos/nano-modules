/*
 * debug.clear_copy_test — Verifies texture clear + texture-to-texture copy.
 *
 *   1. Allocate a scratch texture (rgba8unorm, same size as output).
 *   2. gpu::Device::clear(scratch, R, G, B, A) — fills it with a constant.
 *   3. gpu::Device::copy(scratch, output) — verbatim byte copy.
 *
 * If clear works, the scratch holds the constant. If copy works, the
 * output holds the same constant. The test asserts a uniform output
 * matching the constant — a regression in either path collapses the
 * pixel value to whatever the texture was previously holding.
 *
 * Constant is hard-coded to (0.5, 0.0, 1.0, 1.0) ≈ (128, 0, 255, 255).
 *
 * Class-like instance model: module_init() publishes the schema once per
 * type (no shader/PSO — this effect only uses clear/copy). Each chain
 * entry gets its own State (the scratch texture + size trackers) via
 * create(). All instance callbacks take `self`. The viewport-sized
 * scratch is lazily (re)created in render() on size change.
 */

#include <gpu.h>
#include <host.h>

namespace clear_copy_test {

// Per-instance state. One per chain entry.
struct State {
  gpu::Texture scratch;
  int scratch_w = 0;
  int scratch_h = 0;
  bool initialized = false;
};

// Type-level setup: schema only. No shader/PSO — this effect uses the
// clear/copy device paths, not a compute dispatch. Runs once per type.
void module_init() {
  state::init("debug.clear_copy_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::log("clear_copy_test: module initialized");
}

// Per-instance construction. No per-instance non-viewport buffers — the
// only GPU resource is the viewport-sized scratch, created lazily in
// render().
void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->scratch.release();
  delete s;
}

// Per-instance init tail: reset readiness + size trackers.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  s->scratch_w = 0;
  s->scratch_h = 0;

  if (gpu::Device::backend() == gpu::Backend::None) return;

  s->initialized = true;
  state::log("clear_copy_test: initialized");
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int, const char*, const int*,
                      const int*, const int*) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  if (!s->scratch.valid() || s->scratch_w != w || s->scratch_h != h) {
    s->scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s->scratch_w = w;
    s->scratch_h = h;
  }
  if (!s->scratch.valid()) return;

  gpu::Device::clear(s->scratch, 0.5f, 0.0f, 1.0f, 1.0f);
  gpu::Device::copy(s->scratch, out);
  gpu::Device::submit();
}

} // namespace clear_copy_test
