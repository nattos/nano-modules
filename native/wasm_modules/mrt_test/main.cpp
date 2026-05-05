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
 */

#include <gpu.h>
#include <host.h>
#include "mrt_test_shaders.h"

namespace mrt_test {

static gpu::RenderPSO s_pso_mrt;
static gpu::ComputePSO s_pso_combine;
static gpu::Texture s_scratchA;
static gpu::Texture s_scratchB;
static int s_scratch_w = 0;
static int s_scratch_h = 0;
static bool s_initialized = false;

void init() {
  s_initialized = false;

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

  s_initialized = true;
  state::log("mrt_test: initialized");
}

void tick(double) {}
void on_param_change(int, double) {}
void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int w, int h) {
  if (!s_initialized || w <= 0 || h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  if (!s_scratchA.valid() || s_scratch_w != w || s_scratch_h != h) {
    s_scratchA = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s_scratchB = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA8);
    s_scratch_w = w;
    s_scratch_h = h;
  }
  if (!s_scratchA.valid() || !s_scratchB.valid()) return;

  // Pass 1 — MRT render. Cleared to black then over-written by the fragment.
  {
    auto rp = gpu::RenderPass::beginMRT({
      { s_scratchA, 0.f, 0.f, 0.f, 1.f },
      { s_scratchB, 0.f, 0.f, 0.f, 1.f },
    });
    rp.setPSO(s_pso_mrt);
    rp.draw(3);  // fullscreen triangle, no vertex buffer
    rp.end();
  }

  // Pass 2 — combine.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_combine);
    cp.setTexture(s_scratchA, 0, 0);
    cp.setTexture(s_scratchB, 1, 0);
    cp.setTexture(out,        2, 1);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace mrt_test
