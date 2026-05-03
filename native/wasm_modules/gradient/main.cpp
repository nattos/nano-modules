/*
 * generator.gradient — Two-color linear gradient.
 *
 * Standard params:
 *   angle      [-1, +1]  ±180°. 0 = left-to-right.
 *   offset     [-1, +1]  shifts the gradient along its axis (in cover-square units).
 *   softness   [0, 1]    0 = sharp band, 1 = full gradient.
 *
 * Tuning params:
 *   color_a_r/g/b        gradient start colour. Default white.
 *   color_b_r/g/b        gradient end colour. Default black.
 *
 * The gradient runs through the cover-square so it stays consistent across
 * viewport aspect ratios. Generator: ignores the input texture entirely.
 */

#include <gpu.h>
#include <host.h>
#include <effect_utils.h>
#include "gradient_shaders.h"

#include <cmath>

namespace gradient {

struct Uniforms {
  float dir_x, dir_y;        // unit direction in cover-square units
  float offset;
  float softness;
  float color_a_r, color_a_g, color_a_b;
  float color_b_r;
  float color_b_g, color_b_b;
  float aspect_x, aspect_y;
};

static float s_angle = 0.0f;
static float s_offset = 0.0f;
static float s_softness = 1.0f;
static float s_color_a[3] = { 1.0f, 1.0f, 1.0f };
static float s_color_b[3] = { 0.0f, 0.0f, 0.0f };
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_angle = 0.0f;
  s_offset = 0.0f;
  s_softness = 1.0f;
  s_color_a[0] = s_color_a[1] = s_color_a[2] = 1.0f;
  s_color_b[0] = s_color_b[1] = s_color_b[2] = 0.0f;
  s_initialized = false;

  state::init("generator.gradient", {1, 0, 0},
    state::Schema()
      .floatField("angle",    0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("offset",   0.0f, -1.f, 1.f, state::PrimaryInput)
      .floatField("softness", 1.0f,  0.f, 1.f, state::PrimaryInput)
      .rgbField("color_a", 1.0f, 1.0f, 1.0f, state::SecondaryInput)
      .rgbField("color_b", 0.0f, 0.0f, 0.0f, state::SecondaryInput)
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
    if      (state::pathIs(p, l, "angle"))     s_angle = state::patchFloat(i);
    else if (state::pathIs(p, l, "offset"))    s_offset = state::patchFloat(i);
    else if (state::pathIs(p, l, "softness"))  s_softness = state::patchFloat(i);
    else if (state::pathIs(p, l, "color_a")) {
      auto v = state::patchVec3(i); s_color_a[0] = v.x; s_color_a[1] = v.y; s_color_a[2] = v.z;
    }
    else if (state::pathIs(p, l, "color_b")) {
      auto v = state::patchVec3(i); s_color_b[0] = v.x; s_color_b[1] = v.y; s_color_b[2] = v.z;
    }
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto output = gpu::Device::textureForField("tex_out");
  if (!output.valid()) return;

  auto [ax, ay] = fx::coverSquare(vp_w, vp_h);

  float angle = s_angle * 3.14159265358979323846f;
  Uniforms u = {};
  u.dir_x = std::cos(angle);
  u.dir_y = std::sin(angle);
  u.offset = s_offset;
  u.softness = s_softness;
  u.color_a_r = s_color_a[0]; u.color_a_g = s_color_a[1]; u.color_a_b = s_color_a[2];
  u.color_b_r = s_color_b[0]; u.color_b_g = s_color_b[1]; u.color_b_b = s_color_b[2];
  u.aspect_x = ax; u.aspect_y = ay;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(output, 0, 1);
  cp.setBuffer(s_uniform_buf, 1);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace gradient
