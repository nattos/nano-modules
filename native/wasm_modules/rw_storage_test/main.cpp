/*
 * debug.rw_storage_test — Verifies read-write storage textures.
 *
 * Uses an r32float scratch texture bound as `texture_storage_2d<r32float,
 * read_write>`. The single shader writes a known value, reads it back,
 * adds 0.5, writes back, then reads again — proving the binding really
 * supports both reads and writes within a dispatch.
 *
 * Authored as HLSL (compute.hlsl) → SPV → {MSL native, WGSL web}, the same
 * cross-platform pipeline as every other effect. The two storage textures
 * have different formats: the scratch is pinned to r32f via
 * [[vk::image_format]] (read_write); the output is left at DXC's default and
 * the registerShaderSPV("rgba8unorm","write") override rewrites only it on web.
 *
 * Class-like instance model: module_init() compiles the shared compute
 * PSO + publishes the schema once per type; each chain entry gets its own
 * State (the per-instance scratch RW texture, created lazily in render())
 * via create(). All instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "rw_storage_test_shaders.h"

namespace rw_storage_test {

// Per-instance state. One per chain entry. Holds the lazily-(re)created
// read-write scratch storage texture + its size trackers.
struct State {
  gpu::Texture scratch;
  int          scratch_w = 0;
  int          scratch_h = 0;
  bool         initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso;

// Type-level setup: schema + shared compute PSO. Runs once per type.
void module_init() {
  state::init("debug.rw_storage_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // scratch is pinned to r32f,read_write in the shader; the override rewrites
  // the output's default rgba32float,read_write → rgba8unorm,write on web
  // (rgba8 can't be read_write in WebGPU). Native takes formats from the bound
  // textures.
  state::registerShaderSPV("rw_storage_test", COMPUTE_SPV, COMPUTE_SPV_SIZE,
                           "rgba8unorm", "write");
  auto cs = gpu::Device::createShaderModuleByName("rw_storage_test");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .storageTex2dRW(0, gpu::TextureFormat::R32F)
      .storageTex2d(1,   gpu::TextureFormat::RGBA8));

  state::log("rw_storage_test: module initialized");
}

// Per-instance construction. No per-instance buffers; the scratch RW
// texture stays lazy (created in render() on size change).
void* create() {
  return new State();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->scratch.release();
  delete s;
}

// Per-instance init tail: reset + guard the shared PSO is valid.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  s->scratch_w = 0;
  s->scratch_h = 0;
  if (!s_pso.valid()) return;
  s->initialized = true;
  state::log("rw_storage_test: initialized");
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}


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

  if (!s->scratch.valid() || s->scratch_w != w || s->scratch_h != h) {
    s->scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::R32F);
    s->scratch_w = w;
    s->scratch_h = h;
  }
  if (!s->scratch.valid()) return;

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(s->scratch, 0, 2);  // access=2 (read_write) — host stores it but
                                    // the actual access is encoded in the shader.
  cp.setTexture(out,        1, 1);
  cp.dispatch((w + 7) / 8, (h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace rw_storage_test
