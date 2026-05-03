/*
 * video.fast_blur — Iterative dual-filter blur (Jorge Jimenez,
 * "Next Generation Post Processing in Call of Duty: Advanced
 * Warfare", SIGGRAPH 2014).
 *
 * Each iteration halves the resolution with a 13-tap downsample;
 * the chain is then stepped back up with a 9-tap tent upsample. N
 * iterations cost ~2 × 4/3 × (W·H/4) work, vs O(N · W·H) for a
 * separable Gaussian — significantly cheaper for large blur radii,
 * at the cost of a softer, less mathematically pure shape.
 *
 * Use this when you want a perceptually large blur and can tolerate
 * the slight softness; reach for `video.blur` (`fx::GaussianBlur`)
 * when you need exact Gaussian behaviour or modulation-stable
 * (no-shimmer) tap locations.
 *
 * Parameters:
 *   iterations (int, 1..6) — number of down/up steps. 4 is a good
 *                            "soft, pretty" default; 6 is heavy.
 */

#include <gpu.h>
#include <host.h>
#include "fast_blur_shaders.h"

#include <algorithm>

namespace fast_blur {

struct Uniforms {
  float src_texel_x;
  float src_texel_y;
  // Source binding is always a single-mip view (see dispatch_pass), so
  // the shader samples at view-level 0 — no LOD field needed. Pad to
  // a 16-byte uniform multiple.
  float _pad0;
  float _pad1;
};

static constexpr int MAX_ITERATIONS = 6;
static constexpr int MAX_PASSES     = MAX_ITERATIONS * 2; // N down + N up

static int s_iterations = 4;
static gpu::ComputePSO s_pso_down;
static gpu::ComputePSO s_pso_up;
static gpu::Buffer s_uniform_bufs[MAX_PASSES];
static gpu::Sampler s_sampler;
static gpu::Texture s_scratch;
static int s_scratch_w = 0;     // half-resolution (mip 0 of scratch)
static int s_scratch_h = 0;
static int s_scratch_mips = 0;
static bool s_initialized = false;

static int log2i(int x) {
  int k = 0;
  while (x > 1) { x >>= 1; k++; }
  return k;
}

void init() {
  s_iterations = 4;
  s_initialized = false;

  state::init("video.fast_blur", {1, 0, 0},
    state::Schema()
      .intField("iterations", 4, 1, MAX_ITERATIONS, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
  auto cs_d = gpu::Device::createShaderModule(metal ? DOWN_MSL : DOWN_WGSL);
  auto cs_u = gpu::Device::createShaderModule(metal ? UP_MSL   : UP_WGSL);
  if (!cs_d || !cs_u) return;

  // Same binding shape for both PSOs.
  auto bindings = gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1, gpu::TextureFormat::RGBA8)
      .sampler(2)
      .uniform(3);
  const char* entry = metal ? "main_" : "main";
  s_pso_down = gpu::Device::createComputePSO(cs_d, entry, bindings);
  s_pso_up   = gpu::Device::createComputePSO(cs_u, entry, bindings);

  for (int i = 0; i < MAX_PASSES; i++) {
    s_uniform_bufs[i] = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  }
  s_sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);

  s_initialized = true;
}

void tick(double) {}
void on_param_change(int, double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    if (state::pathIs(pb + off[i], len[i], "iterations")) {
      s_iterations = (int)state::patchFloat(i);
      if (s_iterations < 1) s_iterations = 1;
      if (s_iterations > MAX_ITERATIONS) s_iterations = MAX_ITERATIONS;
    }
  }
}

/// Run one down or up pass.
///   src_mip_w / src_mip_h: dimensions of the source mip we sample from
///                          (drives src_texel uniform).
///   dst_w / dst_h: dimensions of the destination mip (drives dispatch).
static void dispatch_pass(gpu::ComputePSO pso,
                          gpu::Texture src_tex, int src_mip,
                          gpu::Texture dst_tex, int dst_mip,
                          int src_mip_w, int src_mip_h,
                          int dst_w, int dst_h,
                          int uniform_idx) {
  Uniforms u = {
    1.0f / static_cast<float>(src_mip_w > 0 ? src_mip_w : 1),
    1.0f / static_cast<float>(src_mip_h > 0 ? src_mip_h : 1),
    0.f, 0.f,
  };
  s_uniform_bufs[uniform_idx].writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(pso);
  // Both source and destination use single-mip views. Without this,
  // the default sampled view spans all mips of the scratch texture
  // and overlaps the storage write view of one mip — WebGPU rejects
  // overlapping read+write subresources in a single dispatch.
  cp.setTextureMip(src_tex, 0, 0, src_mip);
  cp.setTextureMip(dst_tex, 1, 1, dst_mip);
  cp.setSampler(s_sampler, 2);
  cp.setBuffer(s_uniform_bufs[uniform_idx], 3);
  cp.dispatch((dst_w + 7) / 8, (dst_h + 7) / 8);
  cp.end();
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto src = gpu::Device::textureForField("tex_in");
  auto dst = gpu::Device::textureForField("tex_out");
  if (!src.valid() || !dst.valid()) return;

  // mip 0 of scratch is half-resolution; iteration K reaches mip K-1.
  int half_w = std::max(1, vp_w / 2);
  int half_h = std::max(1, vp_h / 2);
  int max_mips = log2i(std::min(half_w, half_h)) + 1;
  if (max_mips > MAX_ITERATIONS) max_mips = MAX_ITERATIONS;
  if (max_mips < 1) max_mips = 1;

  if (!s_scratch.valid() || s_scratch_w != half_w || s_scratch_h != half_h
      || s_scratch_mips != max_mips) {
    s_scratch_w = half_w;
    s_scratch_h = half_h;
    s_scratch_mips = max_mips;
    s_scratch = gpu::Device::createTextureWithMips(
        half_w, half_h, max_mips, gpu::TextureFormat::RGBA8);
  }
  if (!s_scratch.valid()) return;

  int N = s_iterations;
  if (N < 1) N = 1;
  if (N > s_scratch_mips) N = s_scratch_mips;

  int uIdx = 0;

  // Pass 0: tex_in (full res, mip 0) → scratch.mip[0] (half res).
  dispatch_pass(s_pso_down, src, /*src_mip*/0, s_scratch, /*dst_mip*/0,
                vp_w, vp_h, half_w, half_h, uIdx++);

  // Down chain: scratch.mip[k-1] → scratch.mip[k]
  int cur_w = half_w, cur_h = half_h;
  for (int k = 1; k < N; k++) {
    int next_w = std::max(1, cur_w / 2);
    int next_h = std::max(1, cur_h / 2);
    dispatch_pass(s_pso_down, s_scratch, /*src_mip*/k - 1, s_scratch, /*dst_mip*/k,
                  cur_w, cur_h, next_w, next_h, uIdx++);
    cur_w = next_w; cur_h = next_h;
  }

  // Up chain: scratch.mip[k] → scratch.mip[k-1]. cur_{w,h} currently
  // hold the dimensions of the smallest mip (scratch.mip[N-1]).
  for (int k = N - 1; k > 0; k--) {
    int prev_w = std::max(1, half_w >> (k - 1));
    int prev_h = std::max(1, half_h >> (k - 1));
    dispatch_pass(s_pso_up, s_scratch, /*src_mip*/k, s_scratch, /*dst_mip*/k - 1,
                  cur_w, cur_h, prev_w, prev_h, uIdx++);
    cur_w = prev_w; cur_h = prev_h;
  }

  // Final up: scratch.mip[0] (half res) → tex_out (full res).
  dispatch_pass(s_pso_up, s_scratch, /*src_mip*/0, dst, /*dst_mip*/0,
                half_w, half_h, vp_w, vp_h, uIdx++);

  gpu::Device::submit();
}

} // namespace fast_blur
