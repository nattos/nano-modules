/*
 * video.blur — Single-pass Gaussian-weighted blur.
 *
 * The shader takes a fixed 5×5 = 25 taps with Gaussian weights; the
 * `radius` slider scales the tap spacing in pixels so the slider
 * smoothly controls the visible blur amount:
 *
 *   radius = 0.0  →  spacing 0px  (passthrough)
 *   radius = 1.0  →  spacing scaled to ~5% of the viewport's smaller dim
 *
 * For higher-quality blurs we'll move to a separable two-pass with
 * scratch texture allocation; v1 is intentionally one pass to keep the
 * surface area small.
 */

#include <gpu.h>
#include <host.h>
#include "blur_shaders.h"

namespace blur {

struct Uniforms {
  float offset_x;     // pixels per tap step (after radius scaling)
  float offset_y;     // same — separate from x in case we add anisotropic blur
  float _pad[2];
};

static float s_radius = 0.25f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf;

void init() {
  s_radius = 0.25f;
  s_initialized = false;

  state::init("video.blur", {1, 0, 0},
    state::Schema()
      .floatField("radius", 0.25f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
  if (!cs) return;
  s_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main");
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_initialized = true;
}

void tick(double dt) { (void)dt; }
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "radius"))
      s_radius = state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  // Aspect-aware kernel: spacing measured in viewport-min-dim fraction so the
  // blur reads as a constant visual size regardless of viewport shape. The
  // kernel covers ±2 taps, so per-tap spacing is (radius * max_blur) / 2.
  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  float max_blur_px = static_cast<float>(min_dim) * 0.05f;  // 5% of min dim at radius=1
  float spacing = (s_radius * max_blur_px) / 2.0f;

  Uniforms u = { spacing, spacing, {0, 0} };
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

} // namespace blur
