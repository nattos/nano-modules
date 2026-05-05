/*
 * video.vignette — Darken (or brighten) the edges of the frame around an
 * anchor point.
 *
 * Standard params:
 *   amount       [-1, +1]   negative darkens, positive lightens. 0 = no-op.
 *   radius       [0, 1]     normalized distance at which falloff starts.
 *                           0 = falloff begins at the anchor, 1 = at the cover-square edge.
 *   softness     [0, 1]     length of the soft-edge falloff (perceptual curve).
 *
 * Tuning params:
 *   center_x, center_y      cover-square anchor (style guide §1.5).
 *                           [0, 0] = viewport centre, [-1, 0] = left edge of cover square.
 *   shape        [0, 1]     0 = perfect circle (cover-square units),
 *                           1 = stretched to the viewport's aspect (rectangular vignette).
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "vignette_shaders.h"

namespace vignette {

// Layout MUST match `struct FuseUniforms` in pixel.hlsl. Includes
// vp_w/vp_h because the per-pixel mapper signature gives only (gid,
// c) — we route the viewport size through the uniform so
// fuse_transform can still compute cover-square coordinates.
struct FuseUniforms {
  float amount;
  float radius;
  float softness;
  float shape;
  float center_x;
  float center_y;
  float aspect_x;
  float aspect_y;
  float vp_w;
  float vp_h;
  float _pad0;
  float _pad1;
};

static float s_amount = -0.5f;
static float s_radius = 0.6f;
static float s_softness = 0.4f;
static float s_shape = 0.0f;
static float s_center_x = 0.0f;
static float s_center_y = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void prepare(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);
  FuseUniforms u = {
    s_amount, s_radius, s_softness, s_shape,
    s_center_x, s_center_y,
    ax, ay,
    static_cast<float>(vp_w), static_cast<float>(vp_h),
    0.f, 0.f,
  };
  s_uniform_buf.writeOne(u);
}

void init() {
  s_amount = -0.5f;
  s_radius = 0.6f;
  s_softness = 0.4f;
  s_shape = 0.0f;
  s_center_x = 0.0f;
  s_center_y = 0.0f;
  s_initialized = false;

  state::init("video.vignette", {1, 0, 0},
    state::Schema()
      .floatField("amount",   -0.5f, -1.f, 1.f, state::PrimaryInput)
      .floatField("radius",    0.6f,  0.f, 1.f, state::PrimaryInput)
      .floatField("softness",  0.4f,  0.f, 1.f, state::PrimaryInput)
      .vec2Field("center", 0.0f, 0.0f, state::SecondaryInput, -1.f, 1.f)
      .floatField("shape",     0.0f,  0.f, 1.f, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("compute", COMPUTE_SPV, COMPUTE_SPV_SIZE);
  state::registerShaderSPV("pixel",   PIXEL_SPV,   PIXEL_SPV_SIZE);

  auto cs = gpu::Device::createShaderModuleByName("compute");
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(FuseUniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;

  state::registerFusionByName(state::FusionKind::PerPixelMapper,
                              "pixel",
                              s_uniform_buf.id, sizeof(FuseUniforms),
                              &prepare);
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "amount"))   s_amount   = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius"))   s_radius   = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness")) s_softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "shape"))    s_shape    = state::patchFloat(i);
    else if (state::pathIs(p, l, "center")) {
      auto v = state::patchVec2(i); s_center_x = v.x; s_center_y = v.y;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  prepare(vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace vignette
