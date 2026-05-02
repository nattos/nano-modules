/*
 * video.edges — Sobel edge detection over the luminance of the input.
 *
 * Standard params:
 *   amount      [0, 1]  output mix between input and detected edges.
 *   threshold   [0, 1]  gradient magnitude below this is discarded.
 *
 * Tuning params:
 *   line_color_r/g/b    drawn over detected edges. Default white.
 *   bg_color_r/g/b      filled where no edge is found. Default black.
 *   keep_input  [0, 1]  multiplied with line/bg result so non-edge pixels can
 *                       optionally fade back to the source image instead of bg.
 */

#include <gpu.h>
#include <host.h>
#include "edges_shaders.h"

namespace edges {

struct Uniforms {
  float amount;
  float threshold;
  float keep_input;
  float radius_px;
  float line_r, line_g, line_b;
  float bg_r;
  float bg_g, bg_b;
  float _pad[2];
};

static float s_amount = 1.0f;
static float s_threshold = 0.1f;
static float s_keep_input = 0.0f;
static float s_radius = 0.0f;
static float s_line[3] = { 1.0f, 1.0f, 1.0f };
static float s_bg[3]   = { 0.0f, 0.0f, 0.0f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_amount = 1.0f;
  s_threshold = 0.1f;
  s_keep_input = 0.0f;
  s_radius = 0.0f;
  s_line[0] = s_line[1] = s_line[2] = 1.0f;
  s_bg[0] = s_bg[1] = s_bg[2] = 0.0f;
  s_initialized = false;

  state::init("video.edges", {1, 0, 0},
    state::Schema()
      .floatField("amount",     1.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("threshold",  0.1f, 0.f, 1.f, state::PrimaryInput)
      .floatField("radius",     0.0f, 0.f, 1.f, state::PrimaryInput)
      .floatField("keep_input", 0.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("line_r",     1.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("line_g",     1.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("line_b",     1.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("bg_r",       0.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("bg_g",       0.0f, 0.f, 1.f, state::SecondaryInput)
      .floatField("bg_b",       0.0f, 0.f, 1.f, state::SecondaryInput)
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
    if      (state::pathIs(p, l, "amount"))     s_amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "threshold"))  s_threshold = state::patchFloat(i);
    else if (state::pathIs(p, l, "radius"))     s_radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "keep_input")) s_keep_input = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_r"))     s_line[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_g"))     s_line[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_b"))     s_line[2] = state::patchFloat(i);
    else if (state::pathIs(p, l, "bg_r"))       s_bg[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "bg_g"))       s_bg[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "bg_b"))       s_bg[2] = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  float radius_px = 1.0f + s_radius * (static_cast<float>(min_dim) * 0.025f);

  Uniforms u = {};
  u.amount = s_amount;
  u.threshold = s_threshold;
  u.keep_input = s_keep_input;
  u.radius_px = radius_px;
  u.line_r = s_line[0]; u.line_g = s_line[1]; u.line_b = s_line[2];
  u.bg_r   = s_bg[0];   u.bg_g   = s_bg[1];   u.bg_b   = s_bg[2];
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

} // namespace edges
