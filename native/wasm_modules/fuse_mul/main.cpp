/*
 * debug.fuse_mul — Test-only fusion-aware mapper. Multiplies RGB by a
 * uniform scale and clamps. Test infrastructure only.
 */

#include <gpu.h>
#include <host.h>
#include "fuse_mul_shaders.h"

namespace fuse_mul {

struct FuseUniforms {
  float scale[4];
};

static float s_scale[4] = { 1.f, 1.f, 1.f, 1.f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = {};
  u.scale[0] = s_scale[0];
  u.scale[1] = s_scale[1];
  u.scale[2] = s_scale[2];
  u.scale[3] = s_scale[3];
  s_uniform_buf.writeOne(u);
}

void init() {
  s_scale[0] = s_scale[1] = s_scale[2] = s_scale[3] = 1.f;
  s_initialized = false;

  state::init("debug.fuse_mul", {1, 0, 0},
    state::Schema()
      .vec4Field("scale", 1.f, 1.f, 1.f, 1.f, state::PrimaryInput, 0.f, 4.f)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  state::registerFusion(state::FusionKind::PerPixelMapper,
                        PIXEL_WGSL, PIXEL_MSL,
                        s_uniform_buf.id, sizeof(FuseUniforms),
                        &prepare);
}

void tick(double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if (state::pathIs(p, l, "scale")) {
      auto v = state::patchVec4(i);
      s_scale[0] = v.x; s_scale[1] = v.y; s_scale[2] = v.z; s_scale[3] = v.w;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace fuse_mul
