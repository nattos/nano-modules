/*
 * debug.atomic_test — Verifies atomic ops on storage buffers.
 *
 * Frame layout:
 *   - reset:     CPU writes [0,0,0,0] into a 4-int storage buffer.
 *   - count:     compute shader, per pixel, atomicAdd 1 to bin
 *                clamp(int(luma * 4), 0, 3).
 *   - visualize: compute shader, per pixel, output channel-i = bins[i] / total.
 *
 * Verifies both the host's read_write storage-buffer binding and the
 * round-trip of HLSL InterlockedAdd through naga's atomic codegen.
 *
 * Class-like instance model: module_init() compiles the two shared compute
 * PSOs + publishes the schema once per type; each chain entry gets its own
 * State (per-instance atomic bins + uniform buffer) via create(). All
 * instance callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "atomic_test_shaders.h"

#include <cstdint>

namespace atomic_test {

struct Uniforms {
  float total_inv;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

// Per-instance state. One per chain entry.
struct State {
  gpu::Buffer bins;      // 4 × int32 atomic counters
  gpu::Buffer uniform;
  bool initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso_count;
static gpu::ComputePSO s_pso_vis;

// Type-level setup: schema + the two shared compute PSOs. Runs once per type.
void module_init() {
  state::init("debug.atomic_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // count writes a storage buffer (no storage texture) — default
  // rgba8unorm,write override is irrelevant. visualize writes
  // rgba8unorm output, default works.
  state::registerShaderSPV("count",     COUNT_SPV,     COUNT_SPV_SIZE);
  state::registerShaderSPV("visualize", VISUALIZE_SPV, VISUALIZE_SPV_SIZE);
  auto cs_count = gpu::Device::createShaderModuleByName("count");
  auto cs_vis   = gpu::Device::createShaderModuleByName("visualize");
  if (!cs_count || !cs_vis) return;

  // Explicit layouts. The visualize layout deliberately includes the
  // inputTex slot (0), even though visualize.hlsl doesn't read it —
  // demonstrating that the host honours what we *bind*, not what the
  // shader currently parses.
  s_pso_count = gpu::Device::createComputePSO(cs_count, "main", gpu::Bindings()
      .tex2d(0)
      .storageRW(1));
  s_pso_vis = gpu::Device::createComputePSO(cs_vis, "main", gpu::Bindings()
      .tex2d(0)                                         // unused by shader, OK
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .storage(2)
      .uniform(3));

  state::log("atomic_test: module initialized");
}

// Per-instance construction: allocate State + its own GPU buffers.
void* create() {
  auto* s = new State();
  s->bins    = gpu::Device::createBuffer(4 * sizeof(int32_t), gpu::BufferUsage::Storage);
  s->uniform = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->bins.release();
  s->uniform.release();
  delete s;
}

// Per-instance init tail: mark ready once PSOs + buffers are valid.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_pso_count.valid() || !s_pso_vis.valid()) return;
  if (!s->bins.valid() || !s->uniform.valid()) return;
  s->initialized = true;
  state::log("atomic_test: initialized");
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
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Reset bins to zero before the count pass.
  int32_t zero[4] = {0, 0, 0, 0};
  s->bins.write(zero, 4);

  Uniforms u = { 1.0f / static_cast<float>(w * h), 0, 0, 0 };
  s->uniform.writeOne(u);

  // Pass 1 — atomicAdd into bins.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_count);
    cp.setTexture(in, 0, 0);
    cp.setBuffer(s->bins, 1);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  // Pass 2 — read bins, write visualization. We bind inputTex even
  // though visualize.hlsl doesn't read it; the explicit layout
  // declared the slot, so the host happily provides the resource.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_vis);
    cp.setTexture(in, 0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->bins, 2);
    cp.setBuffer(s->uniform, 3);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  gpu::Device::submit();
}

} // namespace atomic_test
