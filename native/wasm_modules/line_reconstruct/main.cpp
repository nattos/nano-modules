/*
 * filter.reconstruct.line — "Line Reconstruct".
 *
 * A GPU port of the re-edger research harness (nano-fx-prototypes/re-edger). An
 * SMAA-like morphological reconstruction filter: CLASSIFY each pixel as line /
 * point / step-edge / junction / smooth-gradient (subpixel center, width,
 * orientation) in small fixed-footprint passes, then RE-RENDER lines & points as
 * crisp, uniform-width, box-AA strokes (the "4K-downsampled" look) and DE-BAND
 * smooth gradients. Classify-then-resolve (SMAA), contrast-normalized (CAS).
 *
 * Pipeline (per frame, full viewport res — line widths are pixel-exact):
 *   stats + cstar (CAS contrast normalizer)
 *   → pyramid (4 Gaussian levels, fx::GaussianBlur)
 *   → structure tensor (Scharr + eigen)
 *   → features (per-scale ridge/blob, softmax scale blend, width, offsets → M0..M3)
 *   → smooth (polarity/orientation coherence, confidence-weighted smoothing,
 *             fp16-safe shared centerline → S0..S2)
 *   → reconstruct (bilinear flank/center taps, energy-gain repaint, box-AA
 *                  band/disc, deband, gates + hierarchical composite → tex_out)
 *
 * STAGE 1 (this revision): skeleton — registration, full schema, passthrough
 * reconstruct, is_identity(strength<=0). Analysis passes land incrementally.
 *
 * Per-instance instance ABI (class-like): module_init() compiles the shared PSOs
 * + publishes the schema once per type; each chain entry gets its own State.
 */

#include <gpu.h>
#include <host.h>
#include "line_reconstruct_shaders.h"
#include "blur16.h"

#include <cmath>
#include <cstdint>

namespace line_reconstruct {

// --- normalized-param → px mappings (log sliders; see schema help) ------------
// px = lo * pow(hi/lo, t)  →  a perceptually-even width slider.
static inline float logmap(float t, float lo, float hi) {
  return lo * std::pow(hi / lo, t < 0.f ? 0.f : (t > 1.f ? 1.f : t));
}
static constexpr float WIDTH_LO = 0.5f, WIDTH_HI = 4.0f;   // line/point width px
static constexpr float MAXW_LO  = 2.0f, MAXW_HI  = 8.0f;   // max-width cap px

// --- shared uniform layout (16-byte rows; MUST match common.hlsl LRUniforms) --
struct Uniforms {
  float strength, target_width, retarget, point_radius;   // row 0 (px widths)
  float solidify, deband, c_floor, recover;               // row 1
  float max_width, aspect; uint32_t debug_view; float inv_w;  // row 2
  float inv_h; float _p0, _p1, _p2;                       // row 3
};
static_assert(sizeof(Uniforms) == 64, "Uniforms layout mismatch");

// Incremental pyramid sigmas: each blur takes the previous level to the next
// (sqrt of the sigma² difference), keeping every 1-D kernel small.
static const float PYR_INC1 = 1.212436f;   // 0.7 → 1.4
static const float PYR_INC2 = 2.424871f;   // 1.4 → 2.8
static const float PYR_INC3 = 4.849742f;   // 2.8 → 5.6
static const float TENSOR_SIGMA = 1.5f;    // structure-tensor smoothing

// --- per-instance state -------------------------------------------------------
struct State {
  gpu::Buffer  uniform_buf;
  gpu::Sampler sampler;

  // Analysis intermediates (all vp-res RGBA16F).
  gpu::Texture stats;                       // (Y, min3, max3, c)
  gpu::Texture cstar;                       // (c*, -, -, -)
  gpu::Texture y0, y1, y2, y3;              // scale-space luma levels (.r)
  gpu::Texture jraw, jblur;                 // structure-tensor products (Jxx,Jxy,Jyy)
  gpu::Texture tensor;                      // (kappa, junction, 0, 0)
  gpu::Texture m0, m1, m2, m3;             // packed features (see features.hlsl)

  int  tex_w = 0, tex_h = 0;
  bool initialized = false;

  // Schema-mirrored params (normalized unless noted).
  float strength     = 1.0f;
  float target_width = 0.5f;   // → ~1.4 px
  float retarget     = 1.0f;
  float point_radius = 0.42f;  // → ~1.2 px
  float solidify     = 0.6f;
  float deband       = 0.0f;
  float sensitivity  = 0.5f;
  float recover      = 0.7f;
  float max_width    = 0.6f;   // → ~4.6 px
  int   debug_view   = 0;
};

// --- type-shared PSOs ---------------------------------------------------------
static gpu::ComputePSO s_pso_stats, s_pso_cstar, s_pso_tensor_grad, s_pso_tensor,
                       s_pso_features, s_pso_reconstruct;
static Blur16 s_blur;

void module_init() {
  state::init("filter.reconstruct.line", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Line Reconstruct\n"
        "An **SMAA-like morphological reconstructor**. Instead of just boosting "
        "edges, it *classifies* every pixel — line, point, step-edge, junction, or "
        "smooth gradient (with subpixel center, width and orientation) — then "
        "*re-renders* lines and points as crisp, **uniform-width, box-AA strokes** "
        "(the clean \"4K-downsampled\" look) and de-bands smooth gradients. Great "
        "for cleaning up crunchy, aliased, or lightly-blurred line art / graphics.\n\n"
        "**Try:** push *Strength* to de-crunch; set *Line Width* for the target "
        "stroke thickness and *Uniformity* for how hard it forces every line to that "
        "width (0 = clean each line at its own width — the honest mode for fine "
        "detail; 1 = force uniform). Raise *Deband* on banded gradients. Step "
        "*Debug View* to watch the classifier while you tune. At *Strength* 0 it's a "
        "pass-through.")

      .group("detail", "Reconstruct")
        .groupHelp(
          "The live controls. *Strength* is the master mix (0 = bypass). *Line "
          "Width* / *Point Size* are the target sizes strokes and dots are repainted "
          "at. *Uniformity* trades honest per-line width (0) against forcing every "
          "line to the target (1). *Solidify* rescues the true colour of "
          "aliased/dashed strokes from their brightest sample along the line "
          "(self-limiting — it can't over-brighten a uniformly-faint stroke). "
          "*Deband* collapses staircased gradients back onto a smooth ramp.")
      .floatField("strength", 1.0f, 0.f, 1.f, state::PrimaryInput).label("Strength", "Str")
      .floatField("target_width", 0.5f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Target line width. Log-mapped to 0.5..4 px.").label("Line Width", "Width")
      .floatField("retarget", 1.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "0 = clean each line at its own estimated width; 1 = force all lines to Line Width.").label("Uniformity", "Unif")
      .floatField("point_radius", 0.42f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Target point/dot radius. Log-mapped to 0.5..4 px.").label("Point Size", "Point")
      .floatField("solidify", 0.6f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Recover stroke colour from the brightest sample along its length (dash/aliased rescue). Self-limiting.").label("Solidify", "Solid")
      .floatField("deband", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "De-band smooth gradients: clamp-bounded correction (0..4 LSB) + dither.").label("Deband", "Deband")

      .group("tune", "Tuning")
        .groupHelp(
          "Model-shape knobs. *Sensitivity* sets the contrast floor for what counts "
          "as detail (higher = picks up fainter structure). *Recover* controls how "
          "far the repaint may extrapolate contrast past the locally observed colour "
          "range (0 = never invent). *Max Width* caps what still counts as a line.")
      .floatField("sensitivity", 0.5f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Detail contrast floor: lerp(0.12, 0.01). Higher picks up fainter lines.").label("Sensitivity", "Sens")
      .floatField("recover", 0.7f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "How far the repaint extrapolates contrast past local evidence (0 = never invent colour).").label("Recover", "Rec")
      .floatField("max_width", 0.6f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Cap on what counts as a line. Log-mapped to 2..8 px.").label("Max Width", "MaxW")

      .group("debug", "Debug")
        .groupHelp(
          "Inspection aids. *Debug View* replaces the output with an internal "
          "classifier stage — the per-class weights (line=red, point=green, "
          "gradient=blue), the estimated width, the orientation hue, the shared "
          "centerline, or the polarity coherence (the step-edge rejector).")
      .selectField("debug_view", 0, state::SecondaryInput,
                   {{"Off", 0}, {"Class", 1}, {"Width", 2}, {"Orientation", 3},
                    {"Centerline", 4}, {"Pol Coherence", 5}},
                   true, "Visualize an internal classifier stage instead of the reconstruction.").label("Debug View", "Debug")

      .endGroup()
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("line_reconstruct_stats",       STATS_SPV,       STATS_SPV_SIZE,       "rgba16float", "write");
  state::registerShaderSPV("line_reconstruct_cstar",       CSTAR_SPV,       CSTAR_SPV_SIZE,       "rgba16float", "write");
  state::registerShaderSPV("line_reconstruct_tensor_grad", TENSOR_GRAD_SPV, TENSOR_GRAD_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("line_reconstruct_tensor",      TENSOR_SPV,      TENSOR_SPV_SIZE,      "rgba16float", "write");
  state::registerShaderSPV("line_reconstruct_features",    FEATURES_SPV,    FEATURES_SPV_SIZE,    "rgba16float", "write");
  state::registerShaderSPV("line_reconstruct_reconstruct", RECONSTRUCT_SPV, RECONSTRUCT_SPV_SIZE, "rgba8unorm", "write");

  auto cs_st = gpu::Device::createShaderModuleByName("line_reconstruct_stats");
  auto cs_cs = gpu::Device::createShaderModuleByName("line_reconstruct_cstar");
  auto cs_tg = gpu::Device::createShaderModuleByName("line_reconstruct_tensor_grad");
  auto cs_tn = gpu::Device::createShaderModuleByName("line_reconstruct_tensor");
  auto cs_ft = gpu::Device::createShaderModuleByName("line_reconstruct_features");
  auto cs_rc = gpu::Device::createShaderModuleByName("line_reconstruct_reconstruct");
  if (!cs_st || !cs_cs || !cs_tg || !cs_tn || !cs_ft || !cs_rc) {
    state::log("line_reconstruct: shader module compile FAILED "
               "(st,cs,tg,tn,ft,rc valid flags follow)");
    state::log(cs_st ? "  stats ok" : "  stats FAIL");
    state::log(cs_cs ? "  cstar ok" : "  cstar FAIL");
    state::log(cs_tg ? "  tensor_grad ok" : "  tensor_grad FAIL");
    state::log(cs_tn ? "  tensor ok" : "  tensor FAIL");
    state::log(cs_ft ? "  features ok" : "  features FAIL");
    state::log(cs_rc ? "  reconstruct ok" : "  reconstruct FAIL");
    return;
  }

  s_pso_stats = gpu::Device::createComputePSO(cs_st, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA16F));
  s_pso_cstar = gpu::Device::createComputePSO(cs_cs, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA16F).uniform(2));
  s_pso_tensor_grad = gpu::Device::createComputePSO(cs_tg, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA16F));
  s_pso_tensor = gpu::Device::createComputePSO(cs_tn, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).storageTex2d(2, gpu::TextureFormat::RGBA16F));
  s_pso_features = gpu::Device::createComputePSO(cs_ft, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).tex2d(2).tex2d(3).tex2d(4).tex2d(5).tex2d(6)
      .storageTex2d(7, gpu::TextureFormat::RGBA16F)
      .storageTex2d(8, gpu::TextureFormat::RGBA16F)
      .storageTex2d(9, gpu::TextureFormat::RGBA16F)
      .storageTex2d(10, gpu::TextureFormat::RGBA16F).uniform(11));
  s_pso_reconstruct = gpu::Device::createComputePSO(cs_rc, "main", gpu::Bindings()
      .tex2d(0).tex2d(1).tex2d(2).storageTex2d(3, gpu::TextureFormat::RGBA8).uniform(4));
  s_blur.init();

  if (!s_pso_stats.valid())       state::log("line_reconstruct: PSO stats INVALID");
  if (!s_pso_cstar.valid())       state::log("line_reconstruct: PSO cstar INVALID");
  if (!s_pso_tensor_grad.valid()) state::log("line_reconstruct: PSO tensor_grad INVALID");
  if (!s_pso_tensor.valid())      state::log("line_reconstruct: PSO tensor INVALID");
  if (!s_pso_features.valid())    state::log("line_reconstruct: PSO features INVALID");
  if (!s_pso_reconstruct.valid()) state::log("line_reconstruct: PSO reconstruct INVALID");
  if (!s_blur.valid())            state::log("line_reconstruct: Blur16 INVALID");
  state::log("line_reconstruct: module_init done");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

static void releaseTextures(State* s) {
  gpu::Texture* texs[] = { &s->stats, &s->cstar, &s->y0, &s->y1, &s->y2, &s->y3,
                           &s->jraw, &s->jblur, &s->tensor, &s->m0, &s->m1, &s->m2, &s->m3 };
  for (auto* t : texs) if (t->valid()) t->release();
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->sampler.release();
  releaseTextures(s);
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->strength = 1.0f; s->target_width = 0.5f; s->retarget = 1.0f;
  s->point_radius = 0.42f; s->solidify = 0.6f; s->deband = 0.0f;
  s->sensitivity = 0.5f; s->recover = 0.7f; s->max_width = 0.6f;
  s->debug_view = 0;
  s->initialized = (s_pso_stats.valid() && s_pso_features.valid() &&
                    s_pso_reconstruct.valid() && s_blur.valid() &&
                    s->uniform_buf.valid());
}

void tick(void* self, double dt) { (void)self; (void)dt; }

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    int l = len[i];
    if      (state::pathIs(p, l, "strength"))     s->strength     = state::patchFloat(i);
    else if (state::pathIs(p, l, "target_width")) s->target_width = state::patchFloat(i);
    else if (state::pathIs(p, l, "retarget"))     s->retarget     = state::patchFloat(i);
    else if (state::pathIs(p, l, "point_radius")) s->point_radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "solidify"))     s->solidify     = state::patchFloat(i);
    else if (state::pathIs(p, l, "deband"))       s->deband       = state::patchFloat(i);
    else if (state::pathIs(p, l, "sensitivity"))  s->sensitivity  = state::patchFloat(i);
    else if (state::pathIs(p, l, "recover"))      s->recover      = state::patchFloat(i);
    else if (state::pathIs(p, l, "max_width"))    s->max_width    = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_view"))   s->debug_view   = state::patchInt(i);
  }
}

void on_resolume_param(void* self, long long, double) { (void)self; }

// Pure passthrough at strength 0. Stateless (TimeIndependent) — safe to skip.
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return 0;
  return (s->strength <= 0.0f) ? 1 : 0;
}

static void writeUniforms(State* s, int vp_w, int vp_h, Uniforms& u) {
  u.strength     = s->strength;
  u.target_width = logmap(s->target_width, WIDTH_LO, WIDTH_HI);
  u.retarget     = s->retarget;
  u.point_radius = logmap(s->point_radius, WIDTH_LO, WIDTH_HI);
  u.solidify     = s->solidify;
  u.deband       = s->deband;
  u.c_floor      = 0.12f + (0.01f - 0.12f) * s->sensitivity;
  u.recover      = s->recover;
  u.max_width    = logmap(s->max_width, MAXW_LO, MAXW_HI);
  u.aspect       = (float)vp_w / (float)vp_h;
  u.debug_view   = (uint32_t)s->debug_view;
  u.inv_w        = 1.0f / (float)vp_w;
  u.inv_h        = 1.0f / (float)vp_h;
  u._p0 = u._p1 = u._p2 = 0.0f;
}

static bool ensureTextures(State* s, int w, int h) {
  if (s->tex_w == w && s->tex_h == h && s->stats.valid()) return true;
  releaseTextures(s);
  gpu::Texture* texs[] = { &s->stats, &s->cstar, &s->y0, &s->y1, &s->y2, &s->y3,
                           &s->jraw, &s->jblur, &s->tensor, &s->m0, &s->m1, &s->m2, &s->m3 };
  for (auto* t : texs) {
    *t = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA16F);
    if (!t->valid()) return false;
  }
  s->tex_w = w; s->tex_h = h;
  return true;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  if (!ensureTextures(s, vp_w, vp_h)) return;

  Uniforms u = {};
  writeUniforms(s, vp_w, vp_h, u);
  s->uniform_buf.writeOne(u);

  const int gx = (vp_w + 7) / 8, gy = (vp_h + 7) / 8;
  auto pass = [&](gpu::ComputePSO& pso) { auto cp = gpu::ComputePass::begin(); cp.setPSO(pso); return cp; };

  // 1. stats (Y, min3, max3, c).
  { auto cp = pass(s_pso_stats);
    cp.setTexture(in, 0, 0); cp.setTexture(s->stats, 1, 1);
    cp.dispatch(gx, gy); cp.end(); }

  // 1b. c* = 9x9 max of the contrast (CAS normalizer).
  { auto cp = pass(s_pso_cstar);
    cp.setTexture(s->stats, 0, 0); cp.setTexture(s->cstar, 1, 1);
    cp.setBuffer(s->uniform_buf, 2);
    cp.dispatch(gx, gy); cp.end(); }

  // 2. scale-space pyramid (incremental Gaussian levels; .r carries the luma).
  s_blur.apply(s->stats, s->y0, vp_w, vp_h, 0.7f);
  s_blur.apply(s->y0,    s->y1, vp_w, vp_h, PYR_INC1);
  s_blur.apply(s->y1,    s->y2, vp_w, vp_h, PYR_INC2);
  s_blur.apply(s->y2,    s->y3, vp_w, vp_h, PYR_INC3);

  // 3. structure tensor (Scharr products → blur → eigen).
  { auto cp = pass(s_pso_tensor_grad);
    cp.setTexture(s->y1, 0, 0); cp.setTexture(s->jraw, 1, 1);
    cp.dispatch(gx, gy); cp.end(); }
  s_blur.apply(s->jraw, s->jblur, vp_w, vp_h, TENSOR_SIGMA);
  { auto cp = pass(s_pso_tensor);
    cp.setTexture(s->jblur, 0, 0); cp.setTexture(s->cstar, 1, 0);
    cp.setTexture(s->tensor, 2, 1);
    cp.dispatch(gx, gy); cp.end(); }

  // 4. features → M0..M3.
  { auto cp = pass(s_pso_features);
    cp.setTexture(s->y0, 0, 0); cp.setTexture(s->y1, 1, 0);
    cp.setTexture(s->y2, 2, 0); cp.setTexture(s->y3, 3, 0);
    cp.setTexture(s->cstar, 4, 0); cp.setTexture(s->tensor, 5, 0);
    cp.setTexture(s->stats, 6, 0);
    cp.setTexture(s->m0, 7, 1); cp.setTexture(s->m1, 8, 1);
    cp.setTexture(s->m2, 9, 1); cp.setTexture(s->m3, 10, 1);
    cp.setBuffer(s->uniform_buf, 11);
    cp.dispatch(gx, gy); cp.end(); }

  // 6. reconstruct / debug composite → tex_out.
  { auto cp = pass(s_pso_reconstruct);
    cp.setTexture(in, 0, 0); cp.setTexture(s->m0, 1, 0); cp.setTexture(s->m1, 2, 0);
    cp.setTexture(out, 3, 1); cp.setBuffer(s->uniform_buf, 4);
    cp.dispatch(gx, gy); cp.end(); }

  gpu::Device::submit();
}

} // namespace line_reconstruct
