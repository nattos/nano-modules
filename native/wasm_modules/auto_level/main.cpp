/*
 * color.tone.auto_level — histogram auto-leveler.
 *
 * Estimates the input's luminance histogram on the GPU each frame (minmax →
 * hist over a downsample grid), inverts it into a remap curve (buildlut), and
 * applies that curve preserving chroma (apply). Pulled out of the shape_fold
 * generator's auto-levels pipeline; the histogram→CDF math is shared via
 * shaders_common/nano_histogram.hlsl.
 *
 * Two composable curve options, each weighted:
 *   equalize       [0,1]  blend identity → histogram-equalized (flat output
 *                         distribution). 0 = off.
 *   median_target  [0,1]  value to pull the median toward.
 *   median_pull    [0,1]  how strongly to pull the median to the target. 0 = off.
 *
 * Stateless (the histogram is recomputed from the input each frame), so it
 * exposes is_identity for the neutral pass-through. Multi-pass with storage
 * buffers → NO fusion.
 */

#include <gpu.h>
#include <host.h>
#include "auto_level_shaders.h"

#include <cstdint>

namespace auto_level {

// Must match the #defines in common.hlsl.
static constexpr int AL_NB = 256;   // histogram bins / LUT entries
static constexpr int AL_SN = 128;   // auto-levels downsample grid

// Uniform block — mirrors cbuffer U in common.hlsl (std140, 2 scalar rows).
struct Uniforms {
  float res_x, res_y, equalize, median_target;
  float median_pull, _pad0, _pad1, _pad2;
};
static_assert(sizeof(Uniforms) == 8 * 4, "Uniforms layout");

// stats buffer (ints): [0]=lo(asint), [1]=hi(asint), [2..2+NB-1]=hist.
static constexpr int kStatsInts = 2 + AL_NB;
// lut buffer (floats): [0..NB-1]=LUT, [NB]=lo, [NB+1]=hi, [NB+2]=blank.
static constexpr int kLutFloats = AL_NB + 4;

struct State {
  gpu::Buffer uniform_buf;
  gpu::Buffer stats_buf;
  gpu::Buffer lut_buf;
  bool initialized = false;

  // --- Schema-mirrored params ---
  float equalize      = 0.0f;
  float median_target = 0.5f;
  float median_pull   = 0.0f;
};

// Type-shared, compiled once in module_init().
static gpu::ComputePSO s_pso_minmax;
static gpu::ComputePSO s_pso_hist;
static gpu::ComputePSO s_pso_buildlut;
static gpu::ComputePSO s_pso_apply;

void module_init() {
  state::init("color.tone.auto_level", {1, 0, 1},
    state::Schema()
      .helpField("intro",
        "## Auto Level\n"
        "Reads the image's own brightness histogram every frame and remaps tone to "
        "make the most of the available range — chroma is preserved, so only "
        "lightness moves. It reacts live, so it tracks fades and moving content.\n\n"
        "**Try:** dial *Equalize* up for a punchy, contrast-maximised look, or leave "
        "it off and use *Median Pull* alone to gently re-centre exposure toward a "
        "target without crushing the extremes.")
      .group("auto_level", "Auto Level")
        .groupHelp(
          "*Equalize* blends from the untouched image toward a fully flattened "
          "(histogram-equalised) distribution — great for reviving flat, low-contrast "
          "footage, but strong values can look harsh. *Median Pull* nudges the "
          "image's median brightness toward *Median Target*; keep pull low for a "
          "subtle auto-exposure that rides the source.")
      // Flatten the whole curve toward an even (equalized) distribution.
      .floatField("equalize", 0.0f, 0.0f, 1.0f, state::PrimaryInput).label("Equalize", "Equal")
      // Pull the median toward this value, weighted by median_pull.
      .floatField("median_target", 0.5f, 0.0f, 1.0f, state::PrimaryInput).label("Median Target", "Target")
      .floatField("median_pull",   0.0f, 0.0f, 1.0f, state::PrimaryInput).label("Median Pull", "Pull")
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
      .capability(state::Capability::TimeIndependent)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("auto_level_minmax",   MINMAX_SPV,   MINMAX_SPV_SIZE);
  state::registerShaderSPV("auto_level_hist",     HIST_SPV,     HIST_SPV_SIZE);
  state::registerShaderSPV("auto_level_buildlut", BUILDLUT_SPV, BUILDLUT_SPV_SIZE);
  state::registerShaderSPV("auto_level_apply",    APPLY_SPV,    APPLY_SPV_SIZE);

  auto cs_minmax   = gpu::Device::createShaderModuleByName("auto_level_minmax");
  auto cs_hist     = gpu::Device::createShaderModuleByName("auto_level_hist");
  auto cs_buildlut = gpu::Device::createShaderModuleByName("auto_level_buildlut");
  auto cs_apply    = gpu::Device::createShaderModuleByName("auto_level_apply");
  if (!cs_minmax || !cs_hist || !cs_buildlut || !cs_apply) return;

  s_pso_minmax = gpu::Device::createComputePSO(cs_minmax, "main", gpu::Bindings()
      .uniform(0)
      .tex2d(1)
      .storageRW(2));       // stats (atomic min/max)

  s_pso_hist = gpu::Device::createComputePSO(cs_hist, "main", gpu::Bindings()
      .uniform(0)
      .tex2d(1)
      .storageRW(2));       // stats (atomic add)

  s_pso_buildlut = gpu::Device::createComputePSO(cs_buildlut, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)           // stats (read)
      .storageRW(2));       // lut (write)

  s_pso_apply = gpu::Device::createComputePSO(cs_apply, "main", gpu::Bindings()
      .uniform(0)
      .storage(1)                                   // lut (read)
      .tex2d(2)                                     // tex_in
      .storageTex2d(3, gpu::TextureFormat::RGBA8)); // tex_out
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->stats_buf   = gpu::Device::createBuffer(kStatsInts * sizeof(int32_t), gpu::BufferUsage::Storage);
  s->lut_buf     = gpu::Device::createBuffer(kLutFloats * sizeof(float), gpu::BufferUsage::Storage);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->stats_buf.release();
  s->lut_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->equalize = 0.0f;
  s->median_target = 0.5f;
  s->median_pull = 0.0f;
  s->initialized = false;
  if (!s_pso_minmax.valid() || !s_pso_hist.valid() ||
      !s_pso_buildlut.valid() || !s_pso_apply.valid()) return;
  if (!s->uniform_buf.valid() || !s->stats_buf.valid() || !s->lut_buf.valid()) return;
  s->initialized = true;
}

void tick(void* self, double dt) { (void)self; (void)dt; }


// Neutral pass-through: no equalization and no median pull → curve reproduces
// the input. Stateless → skippable.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  return (s && s->equalize == 0.0f && s->median_pull == 0.0f) ? 1 : 0;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i]; int l = len[i];
    if      (state::pathIs(p, l, "equalize"))      s->equalize = state::patchFloat(i);
    else if (state::pathIs(p, l, "median_target")) s->median_target = state::patchFloat(i);
    else if (state::pathIs(p, l, "median_pull"))   s->median_pull = state::patchFloat(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto input  = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  if (!input.valid() || !output.valid()) return;

  Uniforms u = {};
  u.res_x = (float)vp_w;
  u.res_y = (float)vp_h;
  u.equalize = s->equalize;
  u.median_target = s->median_target;
  u.median_pull = s->median_pull;
  s->uniform_buf.writeOne(u);

  // Reset stats: lo = max i32 (asint of +INF-ish), hi = 0 (L ≥ 0), hist = 0.
  int32_t reset[kStatsInts];
  reset[0] = 0x7fffffff;
  reset[1] = 0;
  for (int i = 2; i < kStatsInts; i++) reset[i] = 0;
  s->stats_buf.write(reset, kStatsInts);

  int sg = (AL_SN + 7) / 8;

  // 1 — luminance min/max over the SN×SN grid.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_minmax);
    cp.setBuffer(s->uniform_buf, 0);
    cp.setTexture(input, 1, 0);
    cp.setBuffer(s->stats_buf, 2);
    cp.dispatch(sg, sg);
    cp.end();
  }
  // 2 — histogram into the same stats buffer.
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_hist);
    cp.setBuffer(s->uniform_buf, 0);
    cp.setTexture(input, 1, 0);
    cp.setBuffer(s->stats_buf, 2);
    cp.dispatch(sg, sg);
    cp.end();
  }
  // 3 — invert the histogram into the remap LUT (single invocation).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_buildlut);
    cp.setBuffer(s->uniform_buf, 0);
    cp.setBuffer(s->stats_buf, 1);
    cp.setBuffer(s->lut_buf, 2);
    cp.dispatch(1, 1);
    cp.end();
  }
  // 4 — apply the curve to the image (chroma-preserving).
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_apply);
    cp.setBuffer(s->uniform_buf, 0);
    cp.setBuffer(s->lut_buf, 1);
    cp.setTexture(input, 2, 0);
    cp.setTexture(output, 3, 1);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace auto_level
