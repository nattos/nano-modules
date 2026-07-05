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
#include <effect_blur.h>
#include "line_reconstruct_shaders.h"

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

// --- per-instance state -------------------------------------------------------
struct State {
  gpu::Buffer  uniform_buf;
  gpu::Sampler sampler;
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
static gpu::ComputePSO s_pso_reconstruct;
static fx::GaussianBlur s_blur;

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

  state::registerShaderSPV("line_reconstruct_reconstruct", RECONSTRUCT_SPV, RECONSTRUCT_SPV_SIZE,
                           "rgba8unorm", "write");
  auto cs = gpu::Device::createShaderModuleByName("line_reconstruct_reconstruct");
  if (!cs) return;
  s_pso_reconstruct = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));
  s_blur.init();

  state::log("line_reconstruct: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  s->sampler.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->strength = 1.0f; s->target_width = 0.5f; s->retarget = 1.0f;
  s->point_radius = 0.42f; s->solidify = 0.6f; s->deband = 0.0f;
  s->sensitivity = 0.5f; s->recover = 0.7f; s->max_width = 0.6f;
  s->debug_view = 0;
  s->initialized = (s_pso_reconstruct.valid() && s->uniform_buf.valid());
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

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  s->tex_w = vp_w; s->tex_h = vp_h;

  Uniforms u = {};
  writeUniforms(s, vp_w, vp_h, u);
  s->uniform_buf.writeOne(u);

  // STAGE 1: passthrough. (Analysis passes are inserted before this dispatch as
  // they land; this final pass composites their results into tex_out.)
  {
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_reconstruct);
    cp.setTexture(in,  0, 0);
    cp.setTexture(out, 1, 1);
    cp.setBuffer(s->uniform_buf, 2);
    cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
    cp.end();
  }

  gpu::Device::submit();
}

} // namespace line_reconstruct
