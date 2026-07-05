#pragma once
/*
 * effect_fast_blur.h — Reusable iterative dual-filter blur (Jorge
 * Jimenez, "Next Generation Post Processing in Call of Duty: Advanced
 * Warfare", SIGGRAPH 2014).
 *
 * Why blur is its own header:
 *   Same logic as `effect_blur.h`'s `fx::GaussianBlur` — bloom, glow,
 *   soft-shadow accumulation, depth of field, and dozens of other
 *   "less local" effects all want a wide blur. fx::FastBlur is the
 *   right answer when:
 *
 *     - the radius is large (each iteration roughly doubles the
 *       effective radius for ~4/3 the per-mip cost — much cheaper
 *       than a Gaussian for big blurs),
 *     - the shape doesn't have to be Gaussian-exact (dual-filter is
 *       "soft and pretty", not mathematically pure),
 *     - integer-step radius is acceptable (one iteration per step).
 *
 *   Reach for `fx::GaussianBlur` instead when you need exact Gaussian
 *   shape, smooth (no-shimmer) modulation across radius changes, or a
 *   small-to-medium radius where the Gaussian is competitive.
 *
 * Properties:
 *   - 13-tap downsample → 9-tap tent upsample chain through a
 *     scratch texture with N mips (mip 0 is half-resolution).
 *   - Each pass binds single-mip views via setTextureMip — required
 *     so WebGPU's sync-scope validator doesn't reject reads and
 *     writes to different mips of the same texture in one dispatch.
 *   - Lazy-allocated scratch; reallocated when (w, h) changes.
 *
 * Bundle requirements:
 *   Your bundle's build.sh must compile the down + up shaders into
 *   `fast_blur_shaders.h`:
 *
 *     compile_shaders_compute_var fast_blur down rgba8unorm write down
 *     compile_shaders_compute_var fast_blur up   rgba8unorm write up
 *     _emit_shader_header fast_blur down up
 *
 *   (The .hlsl sources live in `wasm_modules/fast_blur/`. Both core
 *   and any other bundle that uses this utility need these lines.)
 *
 * Usage:
 *
 *   #include <effect_fast_blur.h>
 *
 *   namespace my_effect {
 *     static fx::FastBlur s_blur;
 *     void init() {
 *       // ...state::init...
 *       s_blur.init();
 *     }
 *     void render(int w, int h) {
 *       auto in  = gpu::Device::textureForField("tex_in");
 *       auto out = gpu::Device::textureForField("tex_out");
 *       s_blur.apply(in, out, w, h, s_iterations);
 *       gpu::Device::submit();
 *     }
 *   }
 */

#include <gpu.h>
#include "fast_blur_shaders.h"

#include <algorithm>

namespace fx {

class FastBlur {
public:
  /// Hard cap on iterations. The chain also clamps to the available
  /// mip count for the current viewport (≈ log2(min(w/2, h/2)) + 1).
  static constexpr int MAX_ITERATIONS = 6;

  /// Compile both shaders, allocate uniform buffers + sampler.
  /// Idempotent — safe to call multiple times. Returns false if the
  /// GPU backend is unavailable or the shaders fail to compile.
  bool init() {
    if (m_initialized) return true;
    if (gpu::Device::backend() == gpu::Backend::None) return false;

    state::registerShaderSPV("fast_blur_down", DOWN_SPV, DOWN_SPV_SIZE);
    state::registerShaderSPV("fast_blur_up",   UP_SPV,   UP_SPV_SIZE);
    auto cs_d = gpu::Device::createShaderModuleByName("fast_blur_down");
    auto cs_u = gpu::Device::createShaderModuleByName("fast_blur_up");
    if (!cs_d || !cs_u) return false;

    auto bindings = gpu::Bindings()
        .tex2d(0)
        .storageTex2d(1)   // sketch default — writes scratch mips AND tex_out
        .sampler(2)
        .uniform(3);
    m_pso_down = gpu::Device::createComputePSO(cs_d, "main", bindings);
    m_pso_up   = gpu::Device::createComputePSO(cs_u, "main", bindings);

    for (int i = 0; i < MAX_PASSES; i++) {
      m_uniform_bufs[i] = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
    }
    m_sampler = gpu::Device::createSampler(gpu::FilterMode::Linear,
                                           gpu::AddressMode::ClampToEdge);
    m_initialized = true;
    return true;
  }

  bool valid() const { return m_initialized; }

  /**
   * Run the blur from `input` (full vp resolution) to `output` (same
   * dimensions). `iterations` is clamped to [1, MAX_ITERATIONS] *and*
   * to the available mip depth, so callers don't need to worry about
   * tiny viewports.
   *
   * Both `input` and `output` must be vp_w × vp_h textures with the
   * default (single-mip) layout. The internal scratch is owned by the
   * utility and reallocated lazily on resolution change.
   */
  void apply(gpu::Texture input, gpu::Texture output,
             int vp_w, int vp_h, int iterations) {
    if (!m_initialized || vp_w <= 0 || vp_h <= 0) return;
    if (!input.valid() || !output.valid()) return;

    int half_w = std::max(1, vp_w / 2);
    int half_h = std::max(1, vp_h / 2);
    int max_mips = log2i(std::min(half_w, half_h)) + 1;
    if (max_mips > MAX_ITERATIONS) max_mips = MAX_ITERATIONS;
    if (max_mips < 1) max_mips = 1;

    if (!m_scratch.valid() || m_scratch_w != half_w || m_scratch_h != half_h
        || m_scratch_mips != max_mips) {
      m_scratch_w = half_w;
      m_scratch_h = half_h;
      m_scratch_mips = max_mips;
      m_scratch = gpu::Device::createTextureWithMips(half_w, half_h, max_mips);
    }
    if (!m_scratch.valid()) return;

    int N = iterations;
    if (N < 1) N = 1;
    if (N > m_scratch_mips) N = m_scratch_mips;

    int uIdx = 0;

    // Pass 0: input (full res) → scratch.mip[0] (half res).
    dispatchPass(m_pso_down, input, /*src_mip*/0, m_scratch, /*dst_mip*/0,
                 vp_w, vp_h, half_w, half_h, uIdx++);

    // Down chain.
    int cur_w = half_w, cur_h = half_h;
    for (int k = 1; k < N; k++) {
      int next_w = std::max(1, cur_w / 2);
      int next_h = std::max(1, cur_h / 2);
      dispatchPass(m_pso_down, m_scratch, k - 1, m_scratch, k,
                   cur_w, cur_h, next_w, next_h, uIdx++);
      cur_w = next_w; cur_h = next_h;
    }

    // Up chain. cur_{w,h} hold scratch.mip[N-1]'s dimensions here.
    for (int k = N - 1; k > 0; k--) {
      int prev_w = std::max(1, half_w >> (k - 1));
      int prev_h = std::max(1, half_h >> (k - 1));
      dispatchPass(m_pso_up, m_scratch, k, m_scratch, k - 1,
                   cur_w, cur_h, prev_w, prev_h, uIdx++);
      cur_w = prev_w; cur_h = prev_h;
    }

    // Final up: scratch.mip[0] (half res) → output (full res).
    dispatchPass(m_pso_up, m_scratch, /*src_mip*/0, output, /*dst_mip*/0,
                 half_w, half_h, vp_w, vp_h, uIdx++);
  }

private:
  // N down + N up passes per call. One uniform buffer per pass so
  // we don't write the same buffer twice in a single submit.
  static constexpr int MAX_PASSES = MAX_ITERATIONS * 2;

  struct Uniforms {
    float src_texel_x;
    float src_texel_y;
    float _pad0;
    float _pad1;
  };

  bool m_initialized = false;
  gpu::ComputePSO m_pso_down;
  gpu::ComputePSO m_pso_up;
  gpu::Buffer m_uniform_bufs[MAX_PASSES];
  gpu::Sampler m_sampler;
  gpu::Texture m_scratch;
  int m_scratch_w = 0;
  int m_scratch_h = 0;
  int m_scratch_mips = 0;

  static int log2i(int x) {
    int k = 0;
    while (x > 1) { x >>= 1; k++; }
    return k;
  }

  void dispatchPass(gpu::ComputePSO pso,
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
    m_uniform_bufs[uniform_idx].writeOne(u);

    auto cp = gpu::ComputePass::begin();
    cp.setPSO(pso);
    // Both sides use single-mip views — the default sampled view
    // would span all mips of the scratch and overlap the storage
    // write target, which WebGPU rejects.
    cp.setTextureMip(src_tex, 0, 0, src_mip);
    cp.setTextureMip(dst_tex, 1, 1, dst_mip);
    cp.setSampler(m_sampler, 2);
    cp.setBuffer(m_uniform_bufs[uniform_idx], 3);
    cp.dispatch((dst_w + 7) / 8, (dst_h + 7) / 8);
    cp.end();
  }
};

} // namespace fx
