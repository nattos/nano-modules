/*
 * source.video.file — Host-fed video frame source.
 *
 * A generator whose pixels come from a texture the HOST injects into the
 * "frame" field each frame: the arrangement's main-thread video decode pump
 * decodes a clip frame and binds it via set_texture_field("frame", ...). render()
 * copies that frame to the output; with nothing bound yet it outputs transparent.
 *
 * This lets a video clip act as a normal chain SOURCE — its effects process it
 * and it composites via composite.blend — without a real GPU decoder living in
 * the executor (decode stays on the main thread, like the IDE's video preview).
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include "video_file_shaders.h"

namespace video_file {

// Per-instance state (no params — the frame is host-injected).
struct State {
  bool initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

void module_init() {
  state::init("source.video.file", {1, 0, 0},
    state::Schema()
      // Host-injected decoded frame (not a chain input — the executor never
      // overwrites a secondary field, so the host binding survives each frame).
      .textureField("frame", state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::Generator)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  auto mod = gpu::Device::createShaderModuleByName("compute");
  if (!mod) return;
  s_pso = gpu::Device::createComputePSO(
      mod, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8));
}

void* create() { return new State(); }

void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s || !s_pso.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) { (void)self; (void)dt; }

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  (void)self; (void)n; (void)pb; (void)off; (void)len; (void)ops;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::renderTarget();
  if (!output.valid()) return;

  auto frame = gpu::Device::textureForField("frame");
  if (!frame.valid()) {
    // No decoded frame bound yet → transparent (reveals the layers below).
    gpu_clear_texture(output.id, 0.f, 0.f, 0.f, 0.f);
    return;
  }

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(frame, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace video_file
