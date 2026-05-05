/*
 * GPU Pipeline Test Module
 *
 * Renders a solid color via compute→render pipeline.
 * Color is set via uniform: (0.0, 0.5, 1.0) = blue-ish.
 * Used for automated pixel-level testing of the full GPU pipeline.
 */

#include <gpu.h>
#include <host.h>
#include "gpu_test_shaders.h"

namespace gpu_test {

struct Uniforms { float r, g, b, _pad; };

static gpu::ComputePSO s_compute_pso;
static gpu::RenderPSO s_render_pso;
static gpu::Buffer s_uniform_buf;
static gpu::Buffer s_vertex_buf;
static bool s_initialized = false;

void init() {
  s_initialized = false;

  state::init("debug.gpu_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute",  COMPUTE_SPV,  COMPUTE_SPV_SIZE);
  state::registerShaderSPV("vertex",   VERTEX_SPV,   VERTEX_SPV_SIZE);
  state::registerShaderSPV("fragment", FRAGMENT_SPV, FRAGMENT_SPV_SIZE);

  auto cs_mod = gpu::Device::createShaderModuleByName("compute");
  auto vs_mod = gpu::Device::createShaderModuleByName("vertex");
  auto fs_mod = gpu::Device::createShaderModuleByName("fragment");
  if (!cs_mod || !vs_mod || !fs_mod) return;

  s_compute_pso = gpu::Device::createComputePSO(cs_mod, "main", gpu::Bindings()
      .uniform(0)
      .storageRW(1));  // verts written by compute, read as VB by render
  s_render_pso = gpu::Device::createRenderPSO(
      vs_mod, "main", fs_mod, "main", gpu::TextureFormat::Surface, gpu::Bindings());
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_vertex_buf = gpu::Device::createBuffer(6 * 24, gpu::BufferUsage::Storage);

  Uniforms u = { 0.0f, 0.5f, 1.0f, 0.0f };
  s_uniform_buf.writeOne(u);

  s_initialized = true;
  state::log("gpu_test: initialized");
}

void tick(double dt) { (void)dt; }

void on_param_change(int, double) {}

void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int vp_w, int vp_h) {
  if (!s_initialized) return;
  (void)vp_w; (void)vp_h;

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_compute_pso);
  cp.setBuffer(s_uniform_buf, 0);
  cp.setBuffer(s_vertex_buf, 1);
  cp.dispatch(1);
  cp.end();

  auto rp = gpu::RenderPass::begin(gpu::Device::renderTarget(), 0, 0, 0);
  rp.setPSO(s_render_pso);
  rp.setVertexBuffer(s_vertex_buf);
  rp.draw(6);
  rp.end();

  gpu::Device::submit();
}

} // namespace gpu_test
