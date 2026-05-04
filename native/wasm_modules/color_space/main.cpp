/*
 * video.color_space — Convert RGB between encoding spaces.
 *
 * Two select fields select the input and output encoding (sRGB or
 * Linear). The shader always routes input → linear (canonical) →
 * output, so identity (in == out) and all four combinations work
 * uniformly. Alpha passes through untouched.
 */

#include <gpu.h>
#include <host.h>
#include "color_space_shaders.h"

namespace color_space {

enum Space : int { SpaceSRGB = 0, SpaceLinear = 1 };

struct FuseUniforms {
  int in_space;
  int out_space;
  int _pad0;
  int _pad1;
};

static int s_in_space  = SpaceSRGB;
static int s_out_space = SpaceLinear;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  FuseUniforms u = { s_in_space, s_out_space, 0, 0 };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_in_space = SpaceSRGB;
  s_out_space = SpaceLinear;
  s_initialized = false;

  state::init("video.color_space", {1, 0, 0},
    state::Schema()
      .selectField("in_space",  SpaceSRGB,   state::PrimaryInput, {
          {"sRGB",   SpaceSRGB},
          {"Linear", SpaceLinear},
      })
      .selectField("out_space", SpaceLinear, state::PrimaryInput, {
          {"sRGB",   SpaceSRGB},
          {"Linear", SpaceLinear},
      })
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
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "in_space"))  s_in_space  = (int)state::patchFloat(i);
    else if (state::pathIs(p, l, "out_space")) s_out_space = (int)state::patchFloat(i);
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

} // namespace color_space
