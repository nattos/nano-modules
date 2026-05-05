/*
 * debug.hdr_test — Verifies rgba16float storage textures.
 *
 * Two-pass round-trip: input * 4 → rgba16float scratch → * 0.25 → output.
 * If the scratch is genuinely half-float, the output equals the input
 * (within precision). If the scratch silently became 8-bit unorm, the
 * 4× pre-scale clips and the output crushes to 0.25× the input.
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

static gpu::ComputePSO s_pso_to_hdr;    // writes rgba16float
static gpu::ComputePSO s_pso_from_hdr;  // writes rgba8unorm
static gpu::Buffer s_uniform_to;
static gpu::Buffer s_uniform_from;
static gpu::Texture s_scratch;
static int s_scratch_w = 0;
static int s_scratch_h = 0;
static bool s_initialized = false;

void init() {
  s_initialized = false;

  state::init("debug.hdr_test", {1, 0, 0},
    state::Schema()
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
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
  s_uniform_to   = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_uniform_from = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  Uniforms u_to   = { 4.0f,  0, 0, 0 };
  Uniforms u_from = { 0.25f, 0, 0, 0 };
  s_uniform_to.writeOne(u_to);
  s_uniform_from.writeOne(u_from);

  s_initialized = true;
  state::log("hdr_test: initialized");
}

void tick(double) {}
void on_param_change(int, double) {}
void on_state_patched(int, const char*, const int*, const int*, const int*) {}

void render(int w, int h) {
  if (!s_initialized || w <= 0 || h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  if (!s_scratch.valid() || s_scratch_w != w || s_scratch_h != h) {
    s_scratch = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA16F);
    s_scratch_w = w;
    s_scratch_h = h;
  }
  if (!s_scratch.valid()) return;

  // Pass 1: in → scratch (HDR), gain = 4.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_to_hdr);
    cp.setTexture(in,        0, 0);
    cp.setTexture(s_scratch, 1, 1);
    cp.setBuffer(s_uniform_to, 2);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  // Pass 2: scratch → out, gain = 0.25.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_from_hdr);
    cp.setTexture(s_scratch, 0, 0);
    cp.setTexture(out,       1, 1);
    cp.setBuffer(s_uniform_from, 2);
    cp.dispatch((w + 7) / 8, (h + 7) / 8);
    cp.end();
  }
  gpu::Device::submit();
}

} // namespace hdr_test
