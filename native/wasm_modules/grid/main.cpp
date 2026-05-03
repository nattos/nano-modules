/*
 * generator.grid — Procedural grid pattern.
 *
 * Standard params:
 *   cell_size   [0, 1]   cell side length, in cover-square units (0.05..0.5).
 *   line_width  [0, 1]   line thickness as a fraction of cell side.
 *   softness    [0, 1]   smooth edge between line and fill.
 *
 * Tuning params:
 *   offset_x, offset_y   cover-square shift.
 *   line_r/g/b/a         line colour. Default white opaque.
 *   bg_r/g/b/a           cell fill. Default transparent black.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "grid_shaders.h"

namespace grid {

struct Uniforms {
  float cell_size;
  float line_width;
  float softness;
  float offset_x;
  float offset_y;
  float aspect_x;
  float aspect_y;
  float line_r;
  float line_g, line_b, line_a;
  float bg_r;
  float bg_g, bg_b, bg_a;
  float _pad;
};

static float s_cell = 0.1f;
static float s_line_width = 0.04f;
static float s_softness = 0.1f;
static float s_off_x = 0.0f;
static float s_off_y = 0.0f;
static float s_line[4] = { 1.0f, 1.0f, 1.0f, 1.0f };
static float s_bg[4]   = { 0.0f, 0.0f, 0.0f, 0.0f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_cell = 0.1f;
  s_line_width = 0.04f;
  s_softness = 0.1f;
  s_off_x = 0.0f; s_off_y = 0.0f;
  s_line[0] = s_line[1] = s_line[2] = s_line[3] = 1.0f;
  s_bg[0] = s_bg[1] = s_bg[2] = s_bg[3] = 0.0f;
  s_initialized = false;

  state::init("generator.grid", {1, 0, 0},
    state::Schema()
      .floatField("cell_size",  0.1f,  0.f, 1.f, state::PrimaryInput)
      .floatField("line_width", 0.04f, 0.f, 1.f, state::PrimaryInput)
      .floatField("softness",   0.1f,  0.f, 1.f, state::PrimaryInput)
      .vec2Field("offset", 0.0f, 0.0f, state::SecondaryInput, -1.f, 1.f)
      .rgbaField("line", 1.0f, 1.0f, 1.0f, 1.0f, state::SecondaryInput)
      .rgbaField("bg",   0.0f, 0.0f, 0.0f, 0.0f, state::SecondaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings().storageTex2d(0, gpu::TextureFormat::RGBA8).uniform(1));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    auto* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "cell_size"))  s_cell = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_width")) s_line_width = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness"))   s_softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "offset")) {
      auto v = state::patchVec2(i); s_off_x = v.x; s_off_y = v.y;
    }
    else if (state::pathIs(p, l, "line")) {
      auto v = state::patchVec4(i);
      s_line[0] = v.x; s_line[1] = v.y; s_line[2] = v.z; s_line[3] = v.w;
    }
    else if (state::pathIs(p, l, "bg")) {
      auto v = state::patchVec4(i);
      s_bg[0] = v.x; s_bg[1] = v.y; s_bg[2] = v.z; s_bg[3] = v.w;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::textureForField("tex_out");
  if (!output.valid()) return;

  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);

  Uniforms u = {};
  // Map [0,1] cell_size to [0.02, 0.5] cover-square units so the slider has a useful range.
  u.cell_size = 0.02f + s_cell * 0.48f;
  u.line_width = s_line_width;
  u.softness = s_softness;
  u.offset_x = s_off_x;
  u.offset_y = s_off_y;
  u.aspect_x = ax;
  u.aspect_y = ay;
  u.line_r = s_line[0]; u.line_g = s_line[1]; u.line_b = s_line[2]; u.line_a = s_line[3];
  u.bg_r   = s_bg[0];   u.bg_g   = s_bg[1];   u.bg_b   = s_bg[2];   u.bg_a   = s_bg[3];
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(output, 0, 1);
  cp.setBuffer(s_uniform_buf, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace grid
