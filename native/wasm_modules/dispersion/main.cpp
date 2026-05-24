/*
 * fx.dispersion — Block-quantized UV-jitter sampler (v1 scaffold).
 *
 * Block sizes are internally quantized to a discrete ladder so a
 * sliding slider doesn't visibly sweep boundaries — when the slider
 * crosses a quantization step we ALSO re-roll the start offset so the
 * layout snaps to a fresh arrangement.
 *
 * Deferred for v2: noise-distribution shape (uniform/Gaussian),
 * per-axis temporal rate split, mosaic vs noise vs solid block modes.
 */

#include <gpu.h>
#include <host.h>
#include "dispersion_shaders.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace dispersion {

struct Uniforms {
  int32_t block_w;
  int32_t block_h;
  int32_t start_x;
  int32_t start_y;

  int32_t tick_index;
  float   offset_max;
  float   intensity;
  int32_t seed;
};
static_assert(sizeof(Uniforms) == 32, "Uniforms layout mismatch");

static gpu::ComputePSO s_pso;
static gpu::Buffer     s_uniform_buf;
static gpu::Sampler    s_sampler;
static bool s_initialized = false;

// Schema-mirrored params
static float s_vertical_block_norm   = 0.1f;
static float s_horizontal_block_norm = 0.1f;
static float s_offset_max            = 0.08f;
static float s_intensity             = 1.0f;
static float s_temporal_rate_hz      = 60.0f;
static int   s_quant_v               = 16;
static int   s_quant_h               = 16;
static int   s_block_max_v           = 64;
static int   s_block_max_h           = 64;
static int   s_seed                  = 12345;

// Runtime state
static int      s_last_block_w = -1;
static int      s_last_block_h = -1;
static int      s_start_x      = 0;
static int      s_start_y      = 0;
static int      s_tick_index   = 0;
static double   s_tick_accum   = 0.0;
static uint32_t s_init_lcg     = 0xDEAFBEEFu;

static inline uint32_t lcg_next(uint32_t& s) {
  s = s * 1664525u + 1013904223u;
  return s;
}

// Quantize a [0, 1] norm slider to an integer in [1, max_block] using
// `levels` discrete steps.
static int quantize_block(float norm, int levels, int max_block) {
  if (norm < 0.0f) norm = 0.0f;
  if (norm > 1.0f) norm = 1.0f;
  if (levels < 2) levels = 2;
  if (max_block < 1) max_block = 1;
  int step = (int)std::floor(norm * (float)(levels - 1) + 0.5f);
  // Map step ∈ [0, levels-1] linearly to [1, max_block].
  float t = (float)step / (float)(levels - 1);
  int block = 1 + (int)std::floor(t * (float)(max_block - 1) + 0.5f);
  if (block < 1) block = 1;
  if (block > max_block) block = max_block;
  return block;
}

void init() {
  s_initialized   = false;
  s_last_block_w  = -1;
  s_last_block_h  = -1;
  s_start_x       = 0;
  s_start_y       = 0;
  s_tick_index    = 0;
  s_tick_accum    = 0.0;
  s_init_lcg      = 0xDEAFBEEFu;

  state::init("fx.dispersion", {1, 0, 0},
    state::Schema()
      .floatField("vertical_block_norm",   0.1f,  0.0f, 1.0f, state::PrimaryInput)
      .floatField("horizontal_block_norm", 0.1f,  0.0f, 1.0f, state::PrimaryInput)
      .floatField("offset_max",            0.08f, 0.0f, 0.5f, state::PrimaryInput)
      .floatField("intensity",             1.0f,  0.0f, 1.0f, state::PrimaryInput)
      .floatField("temporal_rate_hz",      60.0f, 0.0f, 60.0f, state::PrimaryInput)
      .intField  ("quantization_levels_vertical",   16, 4, 64, state::PrimaryInput)
      .intField  ("quantization_levels_horizontal", 16, 4, 64, state::PrimaryInput)
      .intField  ("block_max_pixels_vertical",      64, 1, 512, state::PrimaryInput)
      .intField  ("block_max_pixels_horizontal",    64, 1, 512, state::PrimaryInput)
      .intField  ("seed",                  12345, 0,    65535, state::PrimaryInput)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("dispersion_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("dispersion_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .sampler(1)
      .storageTex2d(2, gpu::TextureFormat::RGBA8)
      .uniform(3));
  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s_sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);

  s_initialized = true;
  state::log("dispersion: initialized");
}

void tick(double dt) {
  if (s_temporal_rate_hz > 0.0f) {
    s_tick_accum += dt * (double)s_temporal_rate_hz;
    while (s_tick_accum >= 1.0) {
      s_tick_index++;
      s_tick_accum -= 1.0;
    }
  }
}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if      (state::pathIs(path, plen, "vertical_block_norm"))   s_vertical_block_norm = state::patchFloat(i);
    else if (state::pathIs(path, plen, "horizontal_block_norm")) s_horizontal_block_norm = state::patchFloat(i);
    else if (state::pathIs(path, plen, "offset_max"))            s_offset_max = state::patchFloat(i);
    else if (state::pathIs(path, plen, "intensity"))             s_intensity = state::patchFloat(i);
    else if (state::pathIs(path, plen, "temporal_rate_hz"))      s_temporal_rate_hz = state::patchFloat(i);
    else if (state::pathIs(path, plen, "quantization_levels_vertical"))   s_quant_v = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "quantization_levels_horizontal")) s_quant_h = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "block_max_pixels_vertical"))      s_block_max_v = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "block_max_pixels_horizontal"))    s_block_max_h = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "seed"))                  s_seed = (int)state::patchFloat(i);
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  // Resolve block sizes via the discrete ladder. Anchor block_max to
  // the viewport so the slider scales sensibly when the canvas is small.
  int max_v = (s_block_max_v < vp_h) ? s_block_max_v : vp_h;
  int max_h = (s_block_max_h < vp_w) ? s_block_max_h : vp_w;
  int block_h = quantize_block(s_vertical_block_norm,   s_quant_v, max_v);
  int block_w = quantize_block(s_horizontal_block_norm, s_quant_h, max_h);

  // When block size changes across a quantization step, reroll the
  // start offset so the layout snaps fresh instead of sliding.
  if (block_w != s_last_block_w) {
    s_start_x = (int)(lcg_next(s_init_lcg) % (uint32_t)block_w);
    s_last_block_w = block_w;
  }
  if (block_h != s_last_block_h) {
    s_start_y = (int)(lcg_next(s_init_lcg) % (uint32_t)block_h);
    s_last_block_h = block_h;
  }

  Uniforms u = {};
  u.block_w    = block_w;
  u.block_h    = block_h;
  u.start_x    = s_start_x;
  u.start_y    = s_start_y;
  u.tick_index = s_tick_index;
  u.offset_max = s_offset_max;
  u.intensity  = s_intensity;
  u.seed       = s_seed;
  s_uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in, 0, 0);
  cp.setSampler(s_sampler, 1);
  cp.setTexture(out, 2, 1);
  cp.setBuffer(s_uniform_buf, 3);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace dispersion
