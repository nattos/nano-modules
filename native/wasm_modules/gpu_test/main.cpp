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

struct Uniforms { float r, g, b, _pad; };

static gpu::ComputePSO s_compute_pso;
static gpu::RenderPSO s_render_pso;
static gpu::Buffer s_uniform_buf;
static gpu::Buffer s_vertex_buf;
static bool s_initialized = false;

extern "C" {

__attribute__((export_name("init")))
void init() {
  s_initialized = false;

  state::init("com.nattos.gpu_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  const char* cs = metal ? COMPUTE_MSL : COMPUTE_WGSL;
  const char* vs = metal ? VERTEX_MSL : VERTEX_WGSL;
  const char* fs = metal ? FRAGMENT_MSL : FRAGMENT_WGSL;
  const char* entry = metal ? "main_" : "main";

  auto cs_mod = gpu::Device::createShaderModule(cs);
  auto vs_mod = gpu::Device::createShaderModule(vs);
  auto fs_mod = gpu::Device::createShaderModule(fs);
  if (!cs_mod || !vs_mod || !fs_mod) return;

  s_compute_pso = gpu::Device::createComputePSO(cs_mod, entry);
  s_render_pso = gpu::Device::createRenderPSO(vs_mod, entry, fs_mod, entry);
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_vertex_buf = gpu::Device::createBuffer(6 * 24, gpu::BufferUsage::Storage);

  Uniforms u = { 0.0f, 0.5f, 1.0f, 0.0f };
  s_uniform_buf.writeOne(u);

  s_initialized = true;
  state::log("gpu_test: initialized");
}

__attribute__((export_name("tick")))
void tick(double dt) { (void)dt; }

__attribute__((export_name("on_param_change")))
void on_param_change(int index, double value) { (void)index; (void)value; }


__attribute__((export_name("render")))
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

} // extern "C"
