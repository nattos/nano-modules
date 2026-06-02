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
 * Class-like instance model: module_init() compiles the shared shader
 * modules, the pyramid-reduce PSO, and the linear sampler once per type.
 * Each chain entry gets its own State (params, uniform buffer, pyramid +
 * fallback textures, and its OWN reconstruct PSO — which bakes
 * quality/chroma spec constants, so it differs per instance). All
 * instance callbacks take `self`.
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
// Effective trail reach at each preset (one bilinear sample → 2×2
// pyramid-texel blend → covers ~2 × tile_size source pixels):
//   Low    — mip 4 → 32-px tile, ~64-px reach
//   Medium — mip 5 → 64-px tile, ~128-px reach
//   High   — mip 6 → 128-px tile, ~256-px reach
//
// Earlier this used a 3×3 in-shader max-of-9 expansion at one mip
// finer to extend reach. That produced visible grid artifacts:
// hardware bilinear smooths within each tap, but the discrete max
// still picks a winner per pixel — and when that winner switches at
// boundaries between samples, the gather direction snaps. Single-tap
// bilinear at one mip coarser gives the same reach with no
// winner-switch discontinuities.
static constexpr int PYRAMID_MIP_LOW    = 4;
static constexpr int PYRAMID_MIP_MEDIUM = 5;
static constexpr int PYRAMID_MIP_HIGH   = 6;

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

// Two float4 rows. Layout matches reconstruct.hlsl's cbuffer.
struct Uniforms {
  // row 0
  float strength;
  int   samples;
  float chroma_r;
  float chroma_g;
  // row 1
  float chroma_b;
  float _pad0;
  float _pad1;
  float _pad2;
};
static_assert(sizeof(Uniforms) == 32, "Uniforms layout mismatch");

// Per-instance state. One per chain entry. The reconstruct PSO is here
// (not type-shared) because it bakes the instance's quality/chroma into
// spec constants.
struct State {
  gpu::ComputePSO pso_reconstruct;
  gpu::Buffer     uniform_buf;

  // Pyramid scratch — single texture with mips so the reconstruct
  // shader can `Load(coord, mip)` at the chosen level.
  gpu::Texture pyramid_tex;
  int pyramid_w = 0;
  int pyramid_h = 0;
  int pyramid_levels = 0;

  // Pass-through fallback. Bound when no upstream produces motion.
  gpu::Texture zero_motion;
  gpu::Texture zero_pyramid;
  int zero_w = 0;
  int zero_h = 0;

  float strength = 1.0f;
  int   samples  = 12;
  int   quality  = QUALITY_MEDIUM;
  int   active_pyramid_mip = PYRAMID_MIP_MEDIUM;
  bool  chroma_delay = true;
  float chroma_r = 0.5f;
  float chroma_g = 0.0f;
  float chroma_b = -0.5f;
  bool  initialized = false;
};

// Type-shared: compiled once in module_init().
static gpu::ComputePSO   s_pso_pyramid_reduce;
// Linear-clamp sampler for bilinear pyramid sampling — eliminates
// the visible tile grid that nearest-neighbor Load() would produce
// at tile boundaries.
static gpu::Sampler      s_linear_sampler;
static gpu::ShaderModule s_cs_recon;
static gpu::ShaderModule s_cs_pyramid_reduce;

static int log2_int(int x) {
  int k = 0;
  while (x > 1) { x >>= 1; k++; }
  return k;
}

/// (Re)build the reconstruction PSO with the instance's current preset's
/// spec constants. pyramid_reduce takes no spec constants so it's built
/// once at module_init and shared. Idempotent — safe across preset switches.
static void rebuild_psos(State& st) {
  if (!s_cs_recon || !s_cs_pyramid_reduce) return;

  st.pso_reconstruct.release();

  // TILE_SIZE = 2 << mip compensates for the half-resolution base of
  // the pyramid (each mip k covers 2^(k+1) source pixels).
  // CHROMA_ENABLED is a spec constant so toggling chroma_delay
  // rebuilds the PSO with a chroma-stripped or chroma-included shader
  // — when off, the chroma branch is dead-stripped at compile time.
  int pyramid_tile_size = 2 << st.active_pyramid_mip;
  auto recon_consts = gpu::Constants()
      .set("TILE_SIZE", pyramid_tile_size)
      .set("NEIGHBOR_TEX_MIP", st.active_pyramid_mip)
      // Single-tap bilinear: PYRAMID_NBR_RADIUS=0 collapses the
      // shader's 3×3 expansion loop to one iteration. Bilinear blends
      // 2×2 pyramid texels per sample — V_max varies smoothly across
      // the viewport. The 3×3 max-of-9 path was strictly worse: the
      // discrete max() winner-switches between adjacent pixels, which
      // is visible as grid boundaries even though each individual tap
      // is bilinear-smooth.
      .set("PYRAMID_NBR_RADIUS", 0)
      .set("CHROMA_ENABLED", st.chroma_delay ? 1 : 0);

  st.pso_reconstruct = gpu::Device::createComputePSO(s_cs_recon, "main",
      gpu::Bindings()
          .tex2d(0)   // input color
          .tex2d(1)   // per-pixel motion
          .tex2d(2)   // pyramid (multi-mip)
          .storageTex2d(3, gpu::TextureFormat::RGBA8)
          .uniform(4)
          .sampler(5),  // linear-clamp for pyramid bilinear
      recon_consts);
}

static void apply_quality(State& st, int quality) {
  if (quality < QUALITY_LOW)  quality = QUALITY_LOW;
  if (quality > QUALITY_HIGH) quality = QUALITY_HIGH;
  st.quality = quality;
  st.active_pyramid_mip = pyramid_mip_for(quality);
}

/// Show R/G/B chroma fields only when chroma_delay is on. Called from
/// on_state_ready (once after init + state replay) and from
/// on_state_patched whenever chroma_delay changes.
static void apply_chroma_visibility(State& st) {
  bool hide = !st.chroma_delay;
  state::setFieldHidden("chroma_r", hide);
  state::setFieldHidden("chroma_g", hide);
  state::setFieldHidden("chroma_b", hide);
}

static void on_state_ready(void* self) {
  auto* st = static_cast<State*>(self);
  if (st) apply_chroma_visibility(*st);
}

// Type-level setup: schema + shared shader modules, pyramid-reduce PSO,
// and the linear sampler.
void module_init() {
  state::init("video.motion_blur", {1, 4, 0},
    state::Schema()
      .floatField("strength", 1.0f, 0.f, 4.f, state::PrimaryInput)
      .intField("samples",    12,   4,   32,  state::PrimaryInput)
      .selectField("quality", QUALITY_MEDIUM, state::PrimaryInput, {
        {"Low",    QUALITY_LOW},
        {"Medium", QUALITY_MEDIUM},
        {"High",   QUALITY_HIGH},
      })
      // Stylized chromatic-aberration-along-motion. When on, R/G/B
      // are sampled at independently offset positions along V_max,
      // giving each channel its own velocity-proportional shift —
      // classic RGB-trail look. R/G/B fields below are hidden in the
      // inspector when this is off.
      .boolField("chroma_delay", true, state::PrimaryInput)
      .floatField("chroma_r",  0.5f,  -1.f, 1.f, state::PrimaryInput)
      .floatField("chroma_g",  0.0f,  -1.f, 1.f, state::PrimaryInput)
      .floatField("chroma_b", -0.5f,  -1.f, 1.f, state::PrimaryInput)
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

  s_linear_sampler = gpu::Device::createSampler(
      gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);

  state::log("motion_blur: module initialized");
}

// Per-instance construction: allocate State + its own uniform buffer.
void* create() {
  auto* st = new State();
  st->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return st;
}

void destroy(void* self) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  st->pso_reconstruct.release();
  st->uniform_buf.release();
  st->pyramid_tex.release();
  st->zero_motion.release();
  st->zero_pyramid.release();
  delete st;
}

// Per-instance init tail: defaults + build this instance's reconstruct PSO.
void init(void* self) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  st->strength = 1.0f;
  st->samples  = 12;
  apply_quality(*st, QUALITY_MEDIUM);
  state::setOnStateReady(&on_state_ready);

  if (!s_cs_recon || !s_cs_pyramid_reduce) return;
  if (!st->uniform_buf.valid()) return;

  rebuild_psos(*st);
  st->initialized = true;
}

void tick(void*, double) {}

void on_resolume_param(void*, long long, double) {}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* st = static_cast<State*>(self);
  if (!st) return;
  bool quality_changed = false;
  bool chroma_toggled  = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    int plen = len[i];
    if (state::pathIs(path, plen, "strength")) {
      st->strength = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "samples")) {
      st->samples = (int)state::patchFloat(i);
      if (st->samples < 4)  st->samples = 4;
      if (st->samples > 32) st->samples = 32;
    } else if (state::pathIs(path, plen, "quality")) {
      int q = (int)state::patchFloat(i);
      if (q != st->quality) {
        apply_quality(*st, q);
        quality_changed = true;
      }
    } else if (state::pathIs(path, plen, "chroma_delay")) {
      bool new_val = state::patchFloat(i) != 0.0f;
      if (new_val != st->chroma_delay) {
        st->chroma_delay = new_val;
        chroma_toggled = true;
      }
    } else if (state::pathIs(path, plen, "chroma_r")) {
      st->chroma_r = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "chroma_g")) {
      st->chroma_g = state::patchFloat(i);
    } else if (state::pathIs(path, plen, "chroma_b")) {
      st->chroma_b = state::patchFloat(i);
    }
  }
  // Quality and chroma_delay both bake into spec constants → rebuild
  // the reconstruction PSO. R/G/B values are runtime uniforms so they
  // don't trigger a rebuild.
  if ((quality_changed || chroma_toggled) && st->initialized) {
    rebuild_psos(*st);
  }
  if (chroma_toggled) {
    apply_chroma_visibility(*st);
  }
}

/// (Re)allocate the pyramid texture for the current viewport. Levels
/// run from half-res down to ~1×1.
static bool ensure_pyramid(State& st, int vp_w, int vp_h) {
  int p_w = std::max(1, vp_w / 2);
  int p_h = std::max(1, vp_h / 2);
  int levels = log2_int(std::min(p_w, p_h)) + 1;
  if (levels < 1) levels = 1;
  if (levels > 12) levels = 12;  // WebGPU's typical maxMipLevels cap

  if (st.pyramid_tex.valid()
      && st.pyramid_w == p_w
      && st.pyramid_h == p_h
      && st.pyramid_levels == levels) {
    return true;
  }
  st.pyramid_tex.release();
  st.pyramid_tex = gpu::Device::createTextureWithMips(
      p_w, p_h, levels, gpu::TextureFormat::RGBA16F);
  st.pyramid_w = p_w;
  st.pyramid_h = p_h;
  st.pyramid_levels = levels;
  return st.pyramid_tex.valid();
}

/// Build the pyramid: motion → mip 0, then mip[k] → mip[k+1]. Each
/// reduce dispatch uses single-mip texture views via setTextureMip.
static void dispatch_pyramid_build(State& st, gpu::Texture motion, int vp_w, int vp_h) {
  int dst_w = std::max(1, vp_w / 2);
  int dst_h = std::max(1, vp_h / 2);
  // Level 0: motion → pyramid.mip[0].
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_pyramid_reduce);
    cp.setTextureMip(motion,         0, 0, 0);
    cp.setTextureMip(st.pyramid_tex, 1, 1, 0);
    cp.dispatch((dst_w + 7) / 8, (dst_h + 7) / 8);
    cp.end();
  }
  // Subsequent levels: pyramid.mip[k] → pyramid.mip[k+1].
  for (int k = 0; k < st.pyramid_levels - 1; k++) {
    int next_w = std::max(1, dst_w / 2);
    int next_h = std::max(1, dst_h / 2);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_pyramid_reduce);
    cp.setTextureMip(st.pyramid_tex, 0, 0, k);
    cp.setTextureMip(st.pyramid_tex, 1, 1, k + 1);
    cp.dispatch((next_w + 7) / 8, (next_h + 7) / 8);
    cp.end();
    dst_w = next_w;
    dst_h = next_h;
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* st = static_cast<State*>(self);
  if (!st || !st->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in     = gpu::Device::textureForField("tex_in");
  auto out    = gpu::Device::textureForField("tex_out");
  auto motion = gpu::Device::textureForField("render_outputs/motion");
  if (!in.valid() || !out.valid()) return;

  Uniforms u = {
    st->strength, st->samples, st->chroma_r, st->chroma_g,
    st->chroma_b, 0.f, 0.f, 0.f,
  };
  st->uniform_buf.writeOne(u);

  // No-blur fast path. The reconstruction shader scales V_max by
  // `strength` (reconstruct.hlsl:174) *before* the HALF_VELOCITY_CUTOFF
  // test, so strength <= 0 forces every pixel down the cutoff branch
  // and emits `inputTex[gid]` unchanged — the pyramid build + full
  // gather are pure waste. Treat it like the no-motion case below: one
  // passthrough dispatch, no pyramid (skips ~log2(min(w,h)) reduce
  // dispatches). We can't shortcut to gpu::copy because tex_in/tex_out
  // may have different pixel formats (BGRA8 interop surface vs RGBA8
  // intermediate) and a blit doesn't swizzle; the compute dispatch
  // reads/writes in logical RGBA order, so it's correct across formats.
  const bool no_blur = st->strength <= 0.0f;

  // Pass-through: no upstream motion (or no blur). Bind a viewport-sized
  // zero motion texture and a 1×1 zero pyramid stand-in. Reconstruction's
  // V_max-cutoff branch then fires at every pixel and forwards
  // `inputTex[gid]` directly. Skips the pyramid build entirely.
  if (!motion.valid() || no_blur) {
    if (!st->zero_motion.valid() || st->zero_w != vp_w || st->zero_h != vp_h) {
      st->zero_motion = gpu::Device::createTexture(vp_w, vp_h, gpu::TextureFormat::RGBA16F);
      st->zero_w = vp_w;
      st->zero_h = vp_h;
      if (st->zero_motion.valid()) gpu::Device::clear(st->zero_motion, 0.f, 0.f, 0.f, 0.f);
    }
    if (!st->zero_pyramid.valid()) {
      st->zero_pyramid = gpu::Device::createTexture(1, 1, gpu::TextureFormat::RGBA16F);
      if (st->zero_pyramid.valid()) gpu::Device::clear(st->zero_pyramid, 0.f, 0.f, 0.f, 0.f);
    }
    if (!st->zero_motion.valid() || !st->zero_pyramid.valid()) return;

    auto cp = gpu::ComputePass::begin();
    cp.setPSO(st->pso_reconstruct);
    cp.setTexture(in,              0, 0);
    cp.setTexture(st->zero_motion, 1, 0);
    cp.setTexture(st->zero_pyramid,2, 0);
    cp.setTexture(out,             3, 1);
    cp.setBuffer(st->uniform_buf, 4);
    cp.setSampler(s_linear_sampler, 5);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
    gpu::Device::submit();
    return;
  }

  if (!ensure_pyramid(*st, vp_w, vp_h)) return;
  dispatch_pyramid_build(*st, motion, vp_w, vp_h);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(st->pso_reconstruct);
  cp.setTexture(in,             0, 0);
  cp.setTexture(motion,         1, 0);
  cp.setTexture(st->pyramid_tex,2, 0);
  cp.setTexture(out,            3, 1);
  cp.setBuffer(st->uniform_buf, 4);
  cp.setSampler(s_linear_sampler, 5);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace motion_blur
