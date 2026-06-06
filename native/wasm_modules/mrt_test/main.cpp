/*
 * debug.mrt_test — Verifies multi-render-target rendering.
 *
 * Pass 1: render pass with two color attachments. The fragment shader
 *   writes (1,0,0,1) to target0 (scratchA) and (0,1,0,1) to target1
 *   (scratchB) over a fullscreen triangle.
 * Pass 2: compute combines (scratchA.r, scratchB.g, 0, 1) into the
 *   visible output. Result: yellow if both targets were written.
 *
 * Failure modes: if MRT silently degraded to single-target, scratchB
 * would be untouched (cleared color) and the output would be red.
 *
 * Class-like instance model: module_init() compiles the shared MRT
 * render PSO + combine compute PSO + publishes the schema once per type;
 * each chain entry gets its own State (the viewport-sized MRT target
 * textures) via create(). All instance callbacks take `self`. The MRT
 * target textures stay lazily (re)created in render() on size change.
 */

#include <gpu.h>
#include <host.h>
#include "mrt_test_shaders.h"

namespace mrt_test {

// Per-instance state. One per chain entry.
struct State {
  gpu::Texture scratchA;
  gpu::Texture scratchB;
  int  scratch_w = 0;
  int  scratch_h = 0;
  bool initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::RenderPSO  s_pso_mrt;
static gpu::ComputePSO s_pso_combine;

// Type-level setup: schema + the shared MRT render PSO and combine PSO.
void module_init() {
  state::init("debug.mrt_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute",  COMPUTE_SPV,  COMPUTE_SPV_SIZE);
  state::registerShaderSPV("vertex",   VERTEX_SPV,   VERTEX_SPV_SIZE);
  state::registerShaderSPV("fragment", FRAGMENT_SPV, FRAGMENT_SPV_SIZE);
  auto vs_mod = gpu::Device::createShaderModuleByName("vertex");
  auto fs_mod = gpu::Device::createShaderModuleByName("fragment");
  auto cs_mod = gpu::Device::createShaderModuleByName("compute");
  if (!vs_mod || !fs_mod || !cs_mod) return;

  // MRT pipeline takes no bindings — fragment shader writes constants.
  s_pso_mrt = gpu::Device::createInstancedRenderPSOMRT(
      vs_mod, "main", fs_mod, "main",
      { gpu::TextureFormat::RGBA8, gpu::TextureFormat::RGBA8 },
      gpu::Bindings());
  s_pso_combine = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings()
      .tex2d(0)
      .tex2d(1)
      .storageTex2d(2, gpu::TextureFormat::RGBA8));

  state::log("mrt_test: initialized");
}

// Per-instance construction. No per-instance buffers here; the
// viewport-sized MRT target textures stay lazy in render().
void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->scratchA.release();
  s->scratchB.release();
  delete s;
}

// Per-instance init tail: reset + guard the shared PSOs are valid.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_pso_mrt.valid() || !s_pso_combine.valid()) return;
  s->scratch_w = 0;
  s->scratch_h = 0;
  s->initialized = true;
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int, const char*, const int*, const int*,
                      const int*) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  if (!s->scratchA.valid() || s->scratch_w != w || s->scratch_h != h) {
    s->scratchA = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s->scratchB = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s->scratch_w = w;
    s->scratch_h = h;
  }
  if (!s->scratchA.valid() || !s->scratchB.valid()) return;

  // Pass 1 — MRT render. Cleared to black then over-written by the fragment.
  {
    auto rp = gpu::RenderPass::beginMRT({
      { s->scratchA, 0.f, 0.f, 0.f, 1.f },
      { s->scratchB, 0.f, 0.f, 0.f, 1.f },
    });
    rp.setPSO(s_pso_mrt);
    rp.draw(3);  // fullscreen triangle, no vertex buffer
    rp.end();
  }

  // Pass 2 — combine.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_combine);
    cp.setTexture(s->scratchA, 0, 0);
    cp.setTexture(s->scratchB, 1, 0);
    cp.setTexture(out,         2, 1);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace mrt_test
