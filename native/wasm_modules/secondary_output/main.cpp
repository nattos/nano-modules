/*
 * debug.secondary_output — an effect with a SECOND texture output.
 *
 * `tex_out` (the primary, the stage's render target) is cleared to solid red;
 * `side_out` (a SecondaryOutput) is an effect-owned texture cleared to solid
 * blue and published with state::setGpuTexture. The two colours are distinct
 * on purpose: an output trace that resolves `side_out` to the primary shows
 * red where it should show blue.
 *
 * Pins the editor's per-output trace previews (chain_entry targets carrying a
 * `field`) on both hosts — the only effects with secondary texture outputs
 * otherwise live in nano-modules-extras.
 */

#include <gpu.h>
#include <host.h>

namespace secondary_output {

struct State {
  gpu::Texture side;
  int side_w = 0;
  int side_h = 0;
};

void module_init() {
  state::init("debug.secondary_output", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",   state::PrimaryInput)
      .textureField("tex_out",  state::PrimaryOutput)
      .textureField("side_out", state::SecondaryOutput)
      .capability(state::Capability::TimeIndependent)
  );
}

void* create() { return new State(); }

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->side.release();
  delete s;
}

void init(void*) {}
void tick(void*, double) {}
void on_state_patched(void*, int, const char*, const int*, const int*, const int*) {}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s || w <= 0 || h <= 0) return;
  if (gpu::Device::backend() == gpu::Backend::None) return;
  if (!s->side.valid() || s->side_w != w || s->side_h != h) {
    s->side.release();
    s->side = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s->side_w = w;
    s->side_h = h;
  }
  auto out = gpu::Device::textureForField("tex_out");
  if (out.valid()) gpu::Device::clear(out, 1.0f, 0.0f, 0.0f, 1.0f);
  if (s->side.valid()) {
    gpu::Device::clear(s->side, 0.0f, 0.0f, 1.0f, 1.0f);
    state::setGpuTexture("side_out", s->side.id);
  }
}

} // namespace secondary_output
