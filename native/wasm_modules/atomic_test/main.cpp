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

static gpu::ComputePSO s_pso_count;
static gpu::ComputePSO s_pso_vis;
static gpu::Buffer s_bins;     // 4 × int32 atomic counters
static gpu::Buffer s_uniform;
static bool s_initialized = false;

void init() {
  s_initialized = false;

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
  s_bins      = gpu::Device::createBuffer(4 * sizeof(int32_t), gpu::BufferUsage::Storage);
  s_uniform   = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  s_initialized = true;
  state::log("atomic_test: initialized");
}

void tick(double) {}
void on_param_change(int, double) {}
void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int w, int h) {
  if (!s_initialized || w <= 0 || h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Reset bins to zero before the count pass.
  int32_t zero[4] = {0, 0, 0, 0};
  s_bins.write(zero, 4);

  Uniforms u = { 1.0f / static_cast<float>(w * h), 0, 0, 0 };
  s_uniform.writeOne(u);

  // Pass 1 — atomicAdd into bins.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_count);
    cp.setTexture(in, 0, 0);
    cp.setBuffer(s_bins, 1);
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
    cp.setBuffer(s_bins, 2);
    cp.setBuffer(s_uniform, 3);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  gpu::Device::submit();
}

} // namespace atomic_test
