/*
 * video.crop — Rectangular crop with soft edges.
 *
 * The crop rect is positioned in cover-square coordinates (style guide
 * §1.5) so it stays consistent across viewport aspect ratios. Pixels
 * inside the rect pass through unchanged; pixels outside are pushed to
 * a chosen fill colour (default transparent).
 *
 * Standard params:
 *   center (vec2)        cover-square anchor for the crop centre.
 *   width, height        half-extents in cover-square units (1.0 covers the entire square).
 *   feather              soft edge width.
 *
 * Tuning params:
 *   fill (rgba color)    colour of the masked-out region. Default 0,0,0,0 (transparent).
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "crop_shaders.h"

namespace crop {

struct Uniforms {
  float center_x, center_y;
  float half_w, half_h;
  float feather;
  float aspect_x, aspect_y;
  float fill_r;
  float fill_g, fill_b, fill_a;
  float _pad;
};

static float s_cx = 0.0f, s_cy = 0.0f;
static float s_w = 1.0f, s_h = 1.0f;
static float s_feather = 0.0f;
static float s_fill[4] = { 0.0f, 0.0f, 0.0f, 0.0f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_cx = 0.0f; s_cy = 0.0f;
  s_w = 1.0f; s_h = 1.0f;
  s_feather = 0.0f;
  s_fill[0] = s_fill[1] = s_fill[2] = s_fill[3] = 0.0f;
  s_initialized = false;

  state::init("video.crop", {1, 0, 0},
    state::Schema()
      .vec2Field("center",  0.0f, 0.0f, state::PrimaryInput, -1.f, 1.f)
      .floatField("width",   1.0f,  0.f, 1.f, state::PrimaryInput)
      .floatField("height",  1.0f,  0.f, 1.f, state::PrimaryInput)
      .floatField("feather", 0.0f,  0.f, 1.f, state::PrimaryInput)
      .rgbaField("fill",    0.0f, 0.0f, 0.0f, 0.0f, state::SecondaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings().tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "center"))  { auto v = state::patchVec2(i); s_cx = v.x; s_cy = v.y; }
    else if (state::pathIs(p, l, "width"))    s_w  = state::patchFloat(i);
    else if (state::pathIs(p, l, "height"))   s_h  = state::patchFloat(i);
    else if (state::pathIs(p, l, "feather"))  s_feather = state::patchFloat(i);
    else if (state::pathIs(p, l, "fill")) {
      auto v = state::patchVec4(i);
      s_fill[0] = v.x; s_fill[1] = v.y; s_fill[2] = v.z; s_fill[3] = v.w;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);

  Uniforms u = {};
  u.center_x = s_cx; u.center_y = s_cy;
  u.half_w = s_w; u.half_h = s_h;
  u.feather = s_feather;
  u.aspect_x = ax; u.aspect_y = ay;
  u.fill_r = s_fill[0]; u.fill_g = s_fill[1]; u.fill_b = s_fill[2]; u.fill_a = s_fill[3];
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(input, 0, 0);
  cp.setTexture(output, 1, 1);
  cp.setBuffer(s_uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace crop
