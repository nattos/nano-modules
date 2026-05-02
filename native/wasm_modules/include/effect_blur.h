#pragma once
/*
 * effect_blur.h — Reusable two-pass separable Gaussian blur utility.
 *
 * Why blur is its own header:
 *   blur is the workhorse of "less local" effects — bloom, glow, depth
 *   of field, motion blur, soft-shadow accumulation, AO, energy
 *   diffusion, water/oil paint stylizations, etc. Owning a single tested
 *   implementation pays off across dozens of future effects.
 *
 * Properties:
 *   - Two compute passes (horizontal then vertical) with a shared
 *     CPU-computed weights table.
 *   - Tap LOCATIONS depend only on `spacing_px` (or, in the convenience
 *     wrapper, on `quality`). Modulating `sigma_px` only changes weights
 *     and the active half-count, never the locations. This eliminates
 *     the per-frame shimmer that naive blurs exhibit when their tap
 *     positions slide with the parameter — see EFFECTS_STYLE_GUIDE.md.
 *   - The half-count grows/shrinks with sigma using a 3.5σ coverage
 *     threshold, so newly-active outer taps fade in at weight ~3e-4
 *     (invisible).
 *   - Lazy-allocated scratch texture; reallocated when (w, h) changes.
 *
 * Bundle requirements:
 *   Your bundle's build.sh must include `compile_shaders_compute blur`
 *   so `blur_shaders.h` is generated in TMP_DIR with `COMPUTE_WGSL` and
 *   `COMPUTE_MSL` symbols (both core and any other bundle that uses
 *   this utility need it). The utility includes that header to compile
 *   its PSO at init() time.
 *
 * Usage:
 *
 *   #include <effect_blur.h>
 *
 *   namespace my_effect {
 *     static fx::GaussianBlur s_blur;
 *     void init() {
 *       // ...state::init...
 *       s_blur.init();
 *     }
 *     void render(int w, int h) {
 *       auto in  = gpu::Device::textureForField("tex_in");
 *       auto out = gpu::Device::textureForField("tex_out");
 *       s_blur.applyWithRadius(in, out, w, h, s_radius, s_quality);
 *       gpu::Device::submit();
 *     }
 *   }
 */

#include <gpu.h>
#include "blur_shaders.h"

#include <algorithm>
#include <cmath>

namespace fx {

class GaussianBlur {
public:
  static constexpr int MAX_HALF_COUNT = 128;

  /// Compile the shader and allocate scratch buffers. Idempotent — safe to
  /// call multiple times. Returns false if the GPU backend is unavailable
  /// or the shader fails to compile.
  bool init() {
    if (m_initialized) return true;
    if (gpu::Device::backend() == gpu::Backend::None) return false;

    bool metal = (gpu::Device::backend() == gpu::Backend::Metal);
    auto cs = gpu::Device::createShaderModule(metal ? COMPUTE_MSL : COMPUTE_WGSL);
    if (!cs) return false;
    m_pso = gpu::Device::createComputePSO(cs, metal ? "main_" : "main", gpu::Bindings()
        .tex2d(0)
        .storageTex2d(1, gpu::TextureFormat::RGBA8)
        .uniform(2)
        .storage(3));  // weights[0..MAX_HALF_COUNT]
    m_uniform_h = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
    m_uniform_v = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
    m_weights = gpu::Device::createBuffer(
        sizeof(float) * (MAX_HALF_COUNT + 1), gpu::BufferUsage::Storage);
    m_initialized = true;
    return true;
  }

  bool valid() const { return m_initialized; }

  /**
   * Run a separable two-pass Gaussian blur.
   *   sigma_px   — Gaussian sigma in pixels. ≤0 → identity passthrough.
   *   spacing_px — stride between taps in pixels. 1 = every pixel; >1
   *                means a sparser, faster kernel that covers the same
   *                visual radius with fewer taps.
   *
   * `input` and `output` may differ; the utility always uses an internal
   * scratch texture for the intermediate pass. They must be the same
   * (w, h) as passed in.
   */
  void apply(gpu::Texture input, gpu::Texture output,
             int w, int h, float sigma_px, float spacing_px) {
    if (!m_initialized || w <= 0 || h <= 0) return;
    if (!input.valid() || !output.valid()) return;

    ensureScratch(w, h);
    if (!m_scratch.valid()) return;

    int half_count = computeKernel(sigma_px, spacing_px);

    m_weights.write(m_weights_data, MAX_HALF_COUNT + 1);

    Uniforms uh = { 1.0f, 0.0f, spacing_px, half_count };
    m_uniform_h.writeOne(uh);
    Uniforms uv = { 0.0f, 1.0f, spacing_px, half_count };
    m_uniform_v.writeOne(uv);

    // Pass 1: horizontal — input → scratch.
    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(m_pso);
      cp.setTexture(input, 0, 0);
      cp.setTexture(m_scratch, 1, 1);
      cp.setBuffer(m_uniform_h, 2);
      cp.setBuffer(m_weights, 3);
      cp.dispatch((w + 7) / 8, (h + 7) / 8);
      cp.end();
    }
    // Pass 2: vertical — scratch → output.
    {
      auto cp = gpu::ComputePass::begin();
      cp.setPSO(m_pso);
      cp.setTexture(m_scratch, 0, 0);
      cp.setTexture(output, 1, 1);
      cp.setBuffer(m_uniform_v, 2);
      cp.setBuffer(m_weights, 3);
      cp.dispatch((w + 7) / 8, (h + 7) / 8);
      cp.end();
    }
  }

  /**
   * Convenience overload that maps "playable" parameters to (sigma_px,
   * spacing_px) the same way `video.blur` does — radius drives sigma to
   * a 5%-of-min-dim ceiling, quality drives the tap stride.
   *
   *   radius  ∈ [0, 1] — blur strength.
   *   quality ∈ [0, 1] — sample density. quality=1 → 1 px stride.
   */
  void applyWithRadius(gpu::Texture input, gpu::Texture output,
                       int w, int h, float radius, float quality) {
    float q = quality < 0.05f ? 0.05f : quality;
    float spacing_px = std::max(1.0f, std::round(1.0f / q));
    int min_dim = w < h ? w : h;
    float sigma_px = radius * (static_cast<float>(min_dim) * 0.05f);
    apply(input, output, w, h, sigma_px, spacing_px);
  }

private:
  struct Uniforms {
    float dir_x;
    float dir_y;
    float spacing_px;
    int   half_count;
  };

  bool m_initialized = false;
  gpu::ComputePSO m_pso;
  gpu::Buffer m_uniform_h;
  gpu::Buffer m_uniform_v;
  gpu::Buffer m_weights;
  gpu::Texture m_scratch;
  int m_scratch_w = 0;
  int m_scratch_h = 0;
  float m_weights_data[MAX_HALF_COUNT + 1];

  void ensureScratch(int w, int h) {
    if (m_scratch.valid() && m_scratch_w == w && m_scratch_h == h) return;
    m_scratch = gpu::Device::createTexture(w, h);
    m_scratch_w = w;
    m_scratch_h = h;
  }

  /// Build the kernel for `sigma_px` at the given tap stride. Returns the
  /// active half-count (number of taps on each side of centre, excluding
  /// centre). `m_weights_data[0..half]` is filled with normalized weights;
  /// `m_weights_data[half+1..MAX_HALF_COUNT]` is zeroed.
  int computeKernel(float sigma_px, float spacing_px) {
    if (sigma_px < 1e-3f || spacing_px < 1e-3f) {
      m_weights_data[0] = 1.0f;
      for (int i = 1; i <= MAX_HALF_COUNT; i++) m_weights_data[i] = 0.0f;
      return 0;
    }
    // 3.5σ coverage → boundary tap weight ≈ exp(-12.25/2) ≈ 4.9e-3 raw
    // (~3e-4 after normalization at large σ). Smooth fade-in as half_count
    // steps up by one when sigma grows.
    int half = static_cast<int>(std::ceil(3.5f * sigma_px / spacing_px));
    if (half < 1) half = 1;
    if (half > MAX_HALF_COUNT) half = MAX_HALF_COUNT;

    float sum = 1.0f;  // centre weight = 1 before normalization
    m_weights_data[0] = 1.0f;
    for (int i = 1; i <= half; i++) {
      float x = static_cast<float>(i) * spacing_px;
      float w = std::exp(-(x * x) / (2.0f * sigma_px * sigma_px));
      m_weights_data[i] = w;
      sum += 2.0f * w;
    }
    if (sum > 1e-6f) {
      float inv = 1.0f / sum;
      for (int i = 0; i <= half; i++) m_weights_data[i] *= inv;
    }
    for (int i = half + 1; i <= MAX_HALF_COUNT; i++) m_weights_data[i] = 0.0f;
    return half;
  }
};

} // namespace fx
