/*
 * debug.hdr_test — Verifies rgba16float storage textures.
 *
 * Two-pass round-trip: input * 4 → rgba16float scratch → * 0.25 → output.
 * If the scratch is genuinely half-float, the output equals the input
 * (within precision). If the scratch silently became 8-bit unorm, the
 * 4× pre-scale clips and the output crushes to 0.25× the input.
 *
 * Class-like instance model: module_init() registers the two shader
 * variants + builds the shared compute PSOs + publishes the schema once
 * per type; each chain entry gets its own State (uniform buffers + the
 * lazily-created HDR scratch texture) via create(). All instance
 * callbacks take `self`.
 */

#include <gpu.h>
#include <host.h>
#include "hdr_test_shaders.h"

namespace hdr_test {

struct Uniforms {
  float gain;
  float _pad_x;
  float _pad_y;
  float _pad_z;
};

// Per-instance state. One per chain entry. Holds the per-instance uniform
// buffers and the viewport-sized HDR scratch texture (created lazily in
// render() on first use / size change), plus its size trackers.
struct State {
  gpu::Buffer  uniform_to;
  gpu::Buffer  uniform_from;
  gpu::Texture scratch;
  int          scratch_w = 0;
  int          scratch_h = 0;
  bool         initialized = false;
};

// Type-shared: compiled once in module_init(), reused by every instance.
static gpu::ComputePSO s_pso_to_hdr;    // writes rgba16float
static gpu::ComputePSO s_pso_from_hdr;  // writes rgba8unorm

// Type-level setup: schema + the two shared compute PSOs. Runs once per type.
void module_init() {
  state::init("debug.hdr_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  // Two compiled variants of the same shader, differing only in the
  // storage-texture format the host binds. We thread the format hint
  // through registerShaderSPV so naga emits the right
  // `texture_storage_2d<...>` declaration in the WGSL output.
  state::registerShaderSPV("out16f", OUT16F_SPV, OUT16F_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("out8",   OUT8_SPV,   OUT8_SPV_SIZE,   "rgba8unorm",  "write");
  auto cs_to   = gpu::Device::createShaderModuleByName("out16f");
  auto cs_from = gpu::Device::createShaderModuleByName("out8");
  if (!cs_to || !cs_from) return;

  // Both passes have the same shape: sampled input, storage output,
  // gain uniform — only the output format differs.
  s_pso_to_hdr = gpu::Device::createComputePSO(cs_to, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA16F)
      .uniform(2));
  s_pso_from_hdr = gpu::Device::createComputePSO(cs_from, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));

  state::log("hdr_test: module initialized");
}

// Per-instance construction: allocate State + its own uniform buffers.
// The viewport-sized HDR scratch texture stays lazy — created in render().
void* create() {
  auto* s = new State();
  s->uniform_to   = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->uniform_from = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  Uniforms u_to   = { 4.0f,  0, 0, 0 };
  Uniforms u_from = { 0.25f, 0, 0, 0 };
  s->uniform_to.writeOne(u_to);
  s->uniform_from.writeOne(u_from);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_to.release();
  s->uniform_from.release();
  s->scratch.release();
  delete s;
}

// Per-instance init tail: reset + guard PSOs/buffers valid + mark ready.
void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = false;
  if (!s_pso_to_hdr.valid() || !s_pso_from_hdr.valid()) return;
  if (!s->uniform_to.valid() || !s->uniform_from.valid()) return;
  s->scratch_w = 0;
  s->scratch_h = 0;
  s->initialized = true;
  state::log("hdr_test: initialized");
}

void tick(void* self, double) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)n; (void)pb; (void)off; (void)len; (void)ops;
}

void render(void* self, int w, int h) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (!s->initialized || w <= 0 || h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  if (!s->scratch.valid() || s->scratch_w != w || s->scratch_h != h) {
    s->scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA16F);
    s->scratch_w = w;
    s->scratch_h = h;
  }
  if (!s->scratch.valid()) return;

  // Pass 1: in → scratch (HDR), gain = 4.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_to_hdr);
    cp.setTexture(in,         0, 0);
    cp.setTexture(s->scratch, 1, 1);
    cp.setBuffer(s->uniform_to, 2);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  // Pass 2: scratch → out, gain = 0.25.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_from_hdr);
    cp.setTexture(s->scratch, 0, 0);
    cp.setTexture(out,        1, 1);
    cp.setBuffer(s->uniform_from, 2);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  gpu::Device::submit();
}

} // namespace hdr_test
