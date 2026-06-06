/*
 * GPU Pipeline Test Module
 *
 * Renders a solid color via compute→render pipeline.
 * Color is set via uniform: (0.0, 0.5, 1.0) = blue-ish.
 * Used for automated pixel-level testing of the full GPU pipeline.
 *
 * Class-like instance model: module_init() compiles the shared compute +
 * render PSOs and publishes the schema once per type; each chain entry gets
 * its own State (uniform buffer + vertex buffer) via create(). All instance
 * callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "gpu_test_shaders.h"

namespace gpu_test {

struct Uniforms { float r, g, b, _pad; };

// Per-instance state. One per chain entry.
struct State {
  gpu::Buffer uniform_buf;
  gpu::Buffer vertex_buf;
  bool initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_compute_pso;
static gpu::RenderPSO s_render_pso;

// Type-level setup: schema + shared compute/render PSOs. Runs once per type.
void module_init() {
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

  state::log("gpu_test: module initialized");
}

// Per-instance construction: allocate State + its own uniform/vertex buffers.
void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->vertex_buf = gpu::Device::createBuffer(6 * 24, gpu::BufferUsage::Storage);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->vertex_buf.release();
  delete s;
}

// Per-instance init tail: guard PSOs/buffers, seed the uniform, mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;

  if (!s_compute_pso.valid() || !s_render_pso.valid()) return;
  if (!s->uniform_buf.valid() || !s->vertex_buf.valid()) return;

  Uniforms u = { 0.0f, 0.5f, 1.0f, 0.0f };
  s->uniform_buf.writeOne(u);

  s->initialized = true;
  state::log("gpu_test: initialized");
}

void tick(void* self, double dt) { (void)self; (void)dt; }

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)n; (void)pb; (void)off; (void)len; (void)ops;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;
  (void)vp_w; (void)vp_h;

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_compute_pso);
  cp.setBuffer(s->uniform_buf, 0);
  cp.setBuffer(s->vertex_buf, 1);
  cp.dispatch(1);
  cp.end();

  auto rp = gpu::RenderPass::begin(gpu::Device::renderTarget(), 0, 0, 0);
  rp.setPSO(s_render_pso);
  rp.setVertexBuffer(s->vertex_buf);
  rp.draw(6);
  rp.end();

  gpu::Device::submit();
}

} // namespace gpu_test
