/*
 * debug.fuse_solid — Test-only fusion-aware strict-output generator.
 * Writes a uniform color to every output pixel. Used by the strict-out
 * top + mapper tails fusion tests so we don't depend on a shipping
 * generator's math.
 */

#include <gpu.h>
#include <host.h>
#include "fuse_solid_shaders.h"

namespace fuse_solid {

struct FuseUniforms {
  float color[4];
};

static float s_color[4] = { 0.f, 0.f, 0.f, 1.f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {};
  u.color[0] = s_color[0];
  u.color[1] = s_color[1];
  u.color[2] = s_color[2];
  u.color[3] = s_color[3];
  s_uniform_buf.writeOne(u);
}

void init() {
  s_color[0] = s_color[1] = s_color[2] = 0.f;
  s_color[3] = 1.f;
  s_initialized = false;

  state::init("debug.fuse_solid", {1, 0, 0},
    state::Schema()
      .rgbaField("color", 0.f, 0.f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  // Standalone PSO: only output texture + uniform. No tex_in (this
  // effect doesn't sample anything).
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings()
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  state::registerFusion(state::FusionKind::StrictOutput,
                        PIXEL_WGSL, PIXEL_MSL,
                        s_uniform_buf.id, sizeof(FuseUniforms),
                        &prepare);
}

void tick(double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if (state::pathIs(p, l, "color")) {
      auto v = state::patchVec4(i);
      s_color[0] = v.x; s_color[1] = v.y; s_color[2] = v.z; s_color[3] = v.w;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto out = gpu::Device::textureForField("tex_out");
  if (!out.valid()) return;

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace fuse_solid
