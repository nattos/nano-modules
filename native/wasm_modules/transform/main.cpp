/*
 * video.transform — 2D affine resample of the input texture.
 *
 * Standard params:
 *   scale       [-1, +1]  exponential map: -1 → 1/4, 0 → 1, +1 → 4.
 *   rotation    [-1, +1]  ±180°.
 *   translate (vec2, [-1, +1]²)  cover-square anchor displacement.
 *
 * Tuning params:
 *   pivot (vec2, [-1, +1]²)  cover-square anchor for the origin of scale/rotation.
 *   scale_aspect [-1, +1]    bias the scale toward x-only (-1) or y-only (+1).
 *                            Default 0 = uniform.
 *   wrap_mode    int         0 = clamp to edge (default), 1 = transparent outside,
 *                            2 = repeat, 3 = mirror.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "transform_shaders.h"

#include <cmath>

namespace transform {

struct Uniforms {
  float scale_x, scale_y;
  float cos_r, sin_r;
  float translate_x, translate_y;
  float pivot_x, pivot_y;
  float aspect_x, aspect_y;
  float wrap_mode;
  float _pad;
};

static float s_scale = 0.0f;
static float s_scale_aspect = 0.0f;
static float s_rotation = 0.0f;
static float s_tx = 0.0f, s_ty = 0.0f;
static float s_px = 0.0f, s_py = 0.0f;
static float s_wrap_mode = 0.0f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;
static gpu::Sampler s_sampler;

void init() {
  s_scale = 0.0f;
  s_scale_aspect = 0.0f;
  s_rotation = 0.0f;
  s_tx = 0.0f; s_ty = 0.0f;
  s_px = 0.0f; s_py = 0.0f;
  s_wrap_mode = 0.0f;
  s_initialized = false;

  state::init("video.transform", {1, 0, 0},
    state::Schema()
      .floatField("scale",        0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("rotation",     0.0f, -1.f, 1.f, state::PrimaryInput)
      .vec2Field("translate",     0.0f, 0.0f, state::PrimaryInput, -1.f, 1.f)
      .vec2Field("pivot",         0.0f, 0.0f, state::SecondaryInput, -1.f, 1.f)
      .floatField("scale_aspect", 0.0f, -1.f, 1.f, state::SecondaryInput)
      .intField("wrap_mode",      0,    0,  3,    state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).sampler(2).uniform(3));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  // Bilinear filter, clamp-to-edge addressing. Wrap-mode logic still happens
  // in the shader before sampling so the address mode here is just a fallback.
  s_sampler = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                          gpu::AddressMode::ClampToEdge);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "scale"))        s_scale = state::patchFloat(i);
    else if (state::pathIs(p, l, "rotation"))     s_rotation = state::patchFloat(i);
    else if (state::pathIs(p, l, "translate"))    { auto v = state::patchVec2(i); s_tx = v.x; s_ty = v.y; }
    else if (state::pathIs(p, l, "pivot"))        { auto v = state::patchVec2(i); s_px = v.x; s_py = v.y; }
    else if (state::pathIs(p, l, "scale_aspect")) s_scale_aspect = state::patchFloat(i);
    else if (state::pathIs(p, l, "wrap_mode"))    s_wrap_mode = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  // Cover-square half-extents in viewport-uv units.
  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);

  // Exponential scale: -1 → 1/4, 0 → 1, +1 → 4.
  float base_scale = std::pow(4.0f, s_scale);
  // Aspect bias: -1 = x-only, +1 = y-only, 0 = uniform.
  // Re-distribute a multiplicative factor between the two axes.
  float bias = std::pow(2.0f, s_scale_aspect);  // -1: 0.5, 0: 1, +1: 2
  float sx = base_scale * bias;
  float sy = base_scale / bias;

  // Rotation: ±180° (=±π).
  float angle = s_rotation * 3.14159265358979323846f;

  Uniforms u = {};
  u.scale_x = sx;
  u.scale_y = sy;
  u.cos_r = std::cos(angle);
  u.sin_r = std::sin(angle);
  u.translate_x = s_tx;
  u.translate_y = s_ty;
  u.pivot_x = s_px;
  u.pivot_y = s_py;
  u.aspect_x = ax;
  u.aspect_y = ay;
  u.wrap_mode = s_wrap_mode;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setSampler(s_sampler, 2);
  cp.setBuffer(s_uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace transform
