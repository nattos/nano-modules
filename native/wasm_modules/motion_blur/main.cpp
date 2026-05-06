/*
 * video.motion_blur — Velocity-pyramid McGuire-style motion blur.
 *
 * Consumes the canonical `render_outputs` struct rail (see
 * state::Schema::renderOutputs); reads the optional `motion` texture
 * and reconstructs per-pixel trails along it. If no upstream produces
 * motion, pass-through-copies `tex_in` to `tex_out`.
 *
 * Two passes:
 *
 *   pyramid_reduce  — 2× max-magnitude reduction; dispatched once per
 *                     mip level until the chain reaches 1×1. The
 *                     pyramid is allocated at half source resolution
 *                     so mip k covers a 2^(k+1) × 2^(k+1) block of
 *                     the original motion texture.
 *
 *   reconstruct     — for each output pixel X, sample the chosen
 *                     pyramid mip with a 3×3 in-shader neighbor
 *                     expansion, take the dominant velocity as
 *                     V_max, and gather N taps along ±V_max with
 *                     McGuire foreground/background cone weights.
 *
 * (An earlier TileMax+NeighborMax variant lived alongside this; see
 * git history. Pyramid produced cleaner trails at every quality
 * level — TileMax visibly truncated trails near tile boundaries —
 * for similar compute cost, so it was dropped.)
 */

#include <gpu.h>
#include <host.h>
#include "motion_blur_shaders.h"

#include <algorithm>

namespace motion_blur {

// Pyramid mip levels per quality preset. The pyramid is allocated at
// half source resolution, so mip k covers a 2^(k+1) source-pixel
// block — the reconstruction's `gid / TILE_SIZE` lookup uses
// TILE_SIZE = 2 << mip to land on the correct tile coord.
//
// Effective trail reach at each preset (tile_size × 3 from the 3×3
// in-shader expansion):
//   Low    — mip 3 → 16-px tile, ~48-px reach
//   Medium — mip 4 → 32-px tile, ~96-px reach
//   High   — mip 5 → 64-px tile, ~192-px reach
//
// All exceed what TileMax could provide at similar cost; High at 192
// is fully scalable up to viewport-spanning trails (the limiter is
// V_max, not the tile reach).
static constexpr int PYRAMID_MIP_LOW    = 3;
static constexpr int PYRAMID_MIP_MEDIUM = 4;
static constexpr int PYRAMID_MIP_HIGH   = 5;

enum Quality : int {
  QUALITY_LOW    = 0,
  QUALITY_MEDIUM = 1,
  QUALITY_HIGH   = 2,
};

static int pyramid_mip_for(int quality) {
  switch (quality) {
    case QUALITY_LOW:    return PYRAMID_MIP_LOW;
    case QUALITY_HIGH:   return PYRAMID_MIP_HIGH;
    case QUALITY_MEDIUM:
    default:             return PYRAMID_MIP_MEDIUM;
  }
}

struct Uniforms {
  float strength;
  int   samples;
  float _pad0;
  float _pad1;
};

static gpu::ComputePSO s_pso_pyramid_reduce;
static gpu::ComputePSO s_pso_reconstruct;
static gpu::Buffer     s_uniform_buf;

// Pyramid scratch — single texture with mips so the reconstruct
// shader can `Load(coord, mip)` at the chosen level.
static gpu::Texture s_pyramid_tex;
static int s_pyramid_w = 0;
static int s_pyramid_h = 0;
static int s_pyramid_levels = 0;

// Pass-through fallback. Bound when no upstream produces motion;
// reconstruct's V_max-cutoff branch then forwards `inputTex[gid]`.
// The 1×1 zero pyramid is enough — out-of-bounds reads in the 3×3
// expansion clamp to the same zero-velocity pixel.
static gpu::Texture s_zero_motion;
static gpu::Texture s_zero_pyramid;
static int s_zero_w = 0;
static int s_zero_h = 0;

static float s_strength = 1.0f;
static int   s_samples  = 12;
static int   s_quality  = QUALITY_MEDIUM;
static int   s_active_pyramid_mip = PYRAMID_MIP_MEDIUM;
static bool  s_initialized = false;

static gpu::ShaderModule s_cs_recon;
static gpu::ShaderModule s_cs_pyramid_reduce;

static int log2_int(int x) {
  int k = 0;
  while (x > 1) { x >>= 1; k++; }
  return k;
}

/// (Re)build the reconstruction PSO with the current preset's spec
/// constants. pyramid_reduce takes no spec constants so it's built
/// once at init and shared. Idempotent — safe across preset switches.
static void rebuild_psos() {
  if (!s_cs_recon || !s_cs_pyramid_reduce) return;

  s_pso_reconstruct.release();

  // TILE_SIZE = 2 << mip compensates for the half-resolution base of
  // the pyramid (each mip k covers 2^(k+1) source pixels).
  int pyramid_tile_size = 2 << s_active_pyramid_mip;
  auto recon_consts = gpu::Constants()
      .set("TILE_SIZE", pyramid_tile_size)
      .set("NEIGHBOR_TEX_MIP", s_active_pyramid_mip)
      .set("PYRAMID_NBR_RADIUS", 1);

  s_pso_reconstruct = gpu::Device::createComputePSO(s_cs_recon, "main",
      gpu::Bindings()
          .tex2d(0)   // input color
          .tex2d(1)   // per-pixel motion
          .tex2d(2)   // pyramid (multi-mip)
          .storageTex2d(3, gpu::TextureFormat::RGBA8)
          .uniform(4),
      recon_consts);
}

static void apply_quality(int quality) {
  if (quality < QUALITY_LOW)  quality = QUALITY_LOW;
  if (quality > QUALITY_HIGH) quality = QUALITY_HIGH;
  s_quality = quality;
  s_active_pyramid_mip = pyramid_mip_for(quality);
}

void init() {
  s_strength = 1.0f;
  s_samples  = 12;
  s_initialized = false;
  apply_quality(QUALITY_MEDIUM);

  state::init("video.motion_blur", {1, 3, 0},
    state::Schema()
      .floatField("strength", 1.0f, 0.f, 4.f, state::PrimaryInput)
      .intField("samples",    12,   4,   32,  state::PrimaryInput)
      .selectField("quality", QUALITY_MEDIUM, state::PrimaryInput, {
        {"Low",    QUALITY_LOW},
        {"Medium", QUALITY_MEDIUM},
        {"High",   QUALITY_HIGH},
      })
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .renderOutputs(state::PrimaryInput)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("reconstruct",    RECONSTRUCT_SPV,    RECONSTRUCT_SPV_SIZE);
  state::registerShaderSPV("pyramid_reduce", PYRAMID_REDUCE_SPV, PYRAMID_REDUCE_SPV_SIZE,
                           "rgba16float", "write");

  s_cs_recon          = gpu::Device::createShaderModuleByName("reconstruct");
  s_cs_pyramid_reduce = gpu::Device::createShaderModuleByName("pyramid_reduce");
  if (!s_cs_recon || !s_cs_pyramid_reduce) return;

  s_pso_pyramid_reduce = gpu::Device::createComputePSO(s_cs_pyramid_reduce, "main",
      gpu::Bindings()
          .tex2d(0)
          .storageTex2d(1, gpu::TextureFormat::RGBA16F));

  s_uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);

  rebuild_psos();

  s_initialized = true;
  state::log("motion_blur: initialized");
}

void tick(double) {}

void on_state_patched(int n, const char* pb, const int* off, const int* len, const int* ops) {
  bool quality_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "strength")) {
      s_strength = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "samples")) {
      s_samples = (int)state::patchFloat(i);
      if (s_samples < 4)  s_samples = 4;
      if (s_samples > 32) s_samples = 32;
    } else if (state::pathIs(path, plen, "quality")) {
      int q = (int)state::patchFloat(i);
      if (q != s_quality) {
        apply_quality(q);
        quality_changed = true;
      }
    }
  }
  if (quality_changed && s_initialized) {
    rebuild_psos();
  }
}

/// (Re)allocate the pyramid texture for the current viewport. Levels
/// run from half-res down to ~1×1.
static bool ensure_pyramid(int vp_w, int vp_h) {
  int p_w = std::max(1, vp_w / 2);
  int p_h = std::max(1, vp_h / 2);
  int levels = log2_int(std::min(p_w, p_h)) + 1;
  if (levels < 1) levels = 1;
  if (levels > 12) levels = 12;  // WebGPU's typical maxMipLevels cap

  if (s_pyramid_tex.valid()
      && s_pyramid_w == p_w
      && s_pyramid_h == p_h
      && s_pyramid_levels == levels) {
    return true;
  }
  s_pyramid_tex.release();
  s_pyramid_tex = gpu::Device::createTextureWithMips(
      p_w, p_h, levels, gpu::TextureFormat::RGBA16F);
  s_pyramid_w = p_w;
  s_pyramid_h = p_h;
  s_pyramid_levels = levels;
  return s_pyramid_tex.valid();
}

/// Build the pyramid: motion → mip 0, then mip[k] → mip[k+1]. Each
/// reduce dispatch uses single-mip texture views via setTextureMip.
static void dispatch_pyramid_build(gpu::Texture motion, int vp_w, int vp_h) {
  int dst_w = std::max(1, vp_w / 2);
  int dst_h = std::max(1, vp_h / 2);
  // Level 0: motion → pyramid.mip[0].
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_pyramid_reduce);
    cp.setTextureMip(motion,        0, 0, 0);
    cp.setTextureMip(s_pyramid_tex, 1, 1, 0);
    cp.dispatch((dst_w + 7) / 8, (dst_h + 7) / 8);
    cp.end();
  }
  // Subsequent levels: pyramid.mip[k] → pyramid.mip[k+1].
  for (int k = 0; k < s_pyramid_levels - 1; k++) {
    int next_w = std::max(1, dst_w / 2);
    int next_h = std::max(1, dst_h / 2);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_pyramid_reduce);
    cp.setTextureMip(s_pyramid_tex, 0, 0, k);
    cp.setTextureMip(s_pyramid_tex, 1, 1, k + 1);
    cp.dispatch((next_w + 7) / 8, (next_h + 7) / 8);
    cp.end();
    dst_w = next_w;
    dst_h = next_h;
  }
}

void render(int vp_w, int vp_h) {
  if (!s_initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in     = gpu::Device::textureForField("tex_in");
  auto out    = gpu::Device::textureForField("tex_out");
  auto motion = gpu::Device::textureForField("render_outputs/motion");
  if (!in.valid() || !out.valid()) return;

  Uniforms u = { s_strength, s_samples, 0.f, 0.f };
  s_uniform_buf.writeOne(u);

  // Pass-through: no upstream motion. Bind a viewport-sized zero
  // motion texture and a 1×1 zero pyramid stand-in. Reconstruction's
  // V_max-cutoff branch then fires at every pixel and forwards
  // `inputTex[gid]` directly. Skips the pyramid build entirely.
  if (!motion.valid()) {
    if (!s_zero_motion.valid() || s_zero_w != vp_w || s_zero_h != vp_h) {
      s_zero_motion = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      s_zero_w = vp_w;
      s_zero_h = vp_h;
      if (s_zero_motion.valid()) gpu::Device::clear(s_zero_motion, 0.f, 0.f, 0.f, 0.f);
    }
    if (!s_zero_pyramid.valid()) {
      s_zero_pyramid = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
      if (s_zero_pyramid.valid()) gpu::Device::clear(s_zero_pyramid, 0.f, 0.f, 0.f, 0.f);
    }
    if (!s_zero_motion.valid() || !s_zero_pyramid.valid()) return;

    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_reconstruct);
    cp.setTexture(in,             0, 0);
    cp.setTexture(s_zero_motion,  1, 0);
    cp.setTexture(s_zero_pyramid, 2, 0);
    cp.setTexture(out,            3, 1);
    cp.setBuffer(s_uniform_buf, 4);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
    gpu::Device::submit();
    return;
  }

  if (!ensure_pyramid(vp_w, vp_h)) return;
  dispatch_pyramid_build(motion, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso_reconstruct);
  cp.setTexture(in,            0, 0);
  cp.setTexture(motion,        1, 0);
  cp.setTexture(s_pyramid_tex, 2, 0);
  cp.setTexture(out,           3, 1);
  cp.setBuffer(s_uniform_buf, 4);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace motion_blur
