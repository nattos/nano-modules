/*
 * video.blur — Two-pass separable Gaussian blur.
 *
 *   Pass 1: input  → scratch, 13-tap horizontal Gaussian.
 *   Pass 2: scratch → output, 13-tap vertical Gaussian.
 *
 * Per-tap spacing scales with `radius`, in viewport-min-dim fractions, so
 * the blur reads as a constant visual size regardless of viewport shape.
 *
 * The scratch texture is allocated lazily and reallocated when the
 * viewport size changes.
 */

#include <gpu.h>
#include <host.h>
#include "blur_shaders.h"

namespace blur {

struct Uniforms {
  float dir_x;       // 1 horizontal pass, 0 vertical pass
  float dir_y;       // 0 horizontal pass, 1 vertical pass
  float spacing_px;  // per-tap spacing in pixels
  float _pad;
};

static float s_radius = 0.25f;
static bool s_initialized = false;
static gpu::ComputePSO s_pso;
static gpu::Buffer s_uniform_buf_h;
static gpu::Buffer s_uniform_buf_v;

// Scratch texture for the inter-pass storage. Reallocated on viewport change.
static gpu::Texture s_scratch;
static int s_scratch_w = 0;
static int s_scratch_h = 0;

void init() {
  s_radius = 0.25f;
  s_initialized = false;
  s_scratch_w = 0;
  s_scratch_h = 0;

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
  s_uniform_buf_h = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_uniform_buf_v = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
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

static void ensure_scratch(int vp_w, int vp_h) {
  if (s_scratch.valid() && s_scratch_w == vp_w && s_scratch_h == vp_h) return;
  // Note: we don't release the old handle on resize — small one-time leak.
  s_scratch = gpu::Device::createTexture(vp_w, vp_h);
  s_scratch_w = vp_w;
  s_scratch_h = vp_h;
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;

  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  ensure_scratch(vp_w, vp_h);
  if (!s_scratch.valid()) return;

  // Per-tap spacing in pixels. Each pass covers ±6 taps.
  int min_dim = vp_w < vp_h ? vp_w : vp_h;
  float max_blur_px = static_cast<float>(min_dim) * 0.05f;  // 5% of min dim at radius=1
  float spacing = (s_radius * max_blur_px) / 6.0f;

  Uniforms uh = { 1.0f, 0.0f, spacing, 0.0f };
  s_uniform_buf_h.writeOne(uh);
  Uniforms uv = { 0.0f, 1.0f, spacing, 0.0f };
  s_uniform_buf_v.writeOne(uv);

  // Pass 1: horizontal — input → scratch.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso);
    cp.setTexture(input, 0, 0);
    cp.setTexture(s_scratch, 1, 1);
    cp.setBuffer(s_uniform_buf_h, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }
  // Pass 2: vertical — scratch → output.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso);
    cp.setTexture(s_scratch, 0, 0);
    cp.setTexture(output, 1, 1);
    cp.setBuffer(s_uniform_buf_v, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace blur
