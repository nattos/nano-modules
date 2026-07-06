/*
 * filter.blur.lens — "Lens".
 *
 * A GPU port of the single-plane lens simulation research harness
 * (nano-fx-prototypes/lens-sim). Models a real photographic lens as a linear-HDR
 * pipeline: highlight energy boost → shaped-aperture bokeh gather (the DOF cost
 * centre) → coating colour grade → in-frame veiling glare → off-frame spectral
 * sun/stray-light (veil + directional glow + diffraction streaks + a 6-ghost
 * internal-reflection chain) → halation+bloom → distortion + transverse chromatic
 * aberration → filmic finish (vignette, highlight desat, tonemap, grain).
 *
 * All intermediates RGBA16F, linear-HDR; tonemap only in the final pass (writes
 * the RGBA8 tex_out). The bokeh gather runs at a downsampled proc resolution; the
 * flare/glow passes are low-frequency and run reduced. Every pass is a separate
 * host dispatch so a disabled component is simply not issued (§"Skip whole
 * stages"). See lenssim/{pipeline,optics,coatings}.py for the per-pass math this
 * ports 1:1; the out*\/ study montages are the eyeball golden.
 *
 * STAGE 1 (skeleton): full schema + registration + passthrough copy render.
 * Later stages flesh out the real passes.
 *
 * Per-instance instance ABI (class-like): module_init() compiles the shared PSOs
 * + publishes the schema once per type; each chain entry gets its own State.
 * Presets are UI-only — the `preset` field is inert here (pure serialization); a
 * custom web inspector applies the character-param overrides on change.
 */

#include <gpu.h>
#include <host.h>
#include "lens_shaders.h"

#include <cmath>
#include <cstdint>

namespace lens {

// --- per-instance state -------------------------------------------------------
struct State {
  int  tex_w = 0, tex_h = 0;
  bool initialized = false;

  // Schema-mirrored params (normalized unless noted). Defaults mirror the schema.
  int   preset = 0;             // inert (UI-only); serialized

  // focus
  float blur_amount = 0.16f;
  float field_curvature = 0.0f;
  float focus_cx = 0.0f, focus_cy = 0.0f;
  // bokeh
  int   blades = 7;
  float blade_curvature = 0.15f;
  float aperture_rotation = 0.0f;   // [0,1] → ×TAU
  float cats_eye = 0.8f;
  float swirl = 0.0f;
  float anamorphic = 0.0f;
  float loca = 0.25f;
  float rim = 0.12f;
  float onion_ring = 0.06f;
  float apodize = 0.55f;
  // highlight
  float hl_threshold = 1.0f;
  float hl_boost = 0.375f;          // [0,1] → ×8
  // coating
  int   coating = 0;                // 0 SMC,1 Single,2 Uncoated,3 Custom
  float warmth = 0.0f;
  float transmission = 1.0f;
  // flare
  float flare_strength = 0.5f;
  float hood_extension = 1.0f;
  float hood_shape = 0.3f;
  // sun
  float sun_intensity = 0.0f;
  float sun_azimuth = 0.0955f;      // [0,1] → ×TAU  (0.6 rad)
  float sun_obliqueness = 0.35f;
  float sun_r = 1.0f, sun_g = 0.85f, sun_b = 0.6f;
  float sun_veil = 0.6f;
  float sun_glow = 0.7f;
  float sun_streak = 0.18f;
  float sun_ghost = 0.15f;
  float element_curvature = 0.45f;
  float dispersion = 0.35f;
  // glow
  float halation = 0.22f;
  float hal_r = 1.0f, hal_g = 0.4f, hal_b = 0.22f;
  float bloom = 0.12f;
  // geometry
  float distortion = 0.0f;
  float distortion_wave = 0.0f;
  float tca = 0.0f;
  // finish
  float exposure = 0.0f;            // signed stops [-1,1] → 2^(3s)
  float mech_vignette = 0.25f;
  float hl_desat = 0.6f;
  float tone = 0.85f;
  float tone_black = 0.02f;
  float grain = 0.05f;
  // quality
  int   quality = 1;                // 0 Cheap,1 Standard,2 Max
  int   taps = 96;
  float work_radius = 11.0f;
  float fill = 0.7f;
  // debug
  int   debug_view = 0;
};

// --- type-shared PSOs ---------------------------------------------------------
static gpu::ComputePSO s_pso_finish;   // STAGE 1: passthrough copy

void module_init() {
  state::init("filter.blur.lens", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Lens\n"
        "A **full photographic-lens model** in one effect: shaped-aperture "
        "depth-of-field **bokeh**, lens **flare & glare**, chromatic aberration, "
        "distortion, and a filmic **finish** (tonemap + grain). Unlike a plain "
        "blur it energy-normalises highlights (so bright points bloom into real "
        "bokeh discs), shapes the blur with the aperture polygon, and composites "
        "everything in linear HDR before the film curve — the look real glass has "
        "and phones clip away.\n\n"
        "**Try:** raise *Blur Amount* for depth-of-field; open the *Bokeh Shape* "
        "group for character (cat's-eye, swirl, anamorphic ovals); switch *Coating* "
        "and dial *Warmth*; enable *Sun* for anamorphic streaks and ghosts; add "
        "*Halation* / *Bloom* for filmic glow. The **preset** picker (SMC prime, "
        "vintage swirl, anamorphic, dreamy, clinical) sets a whole look at once — "
        "then tweak.")

      // preset — inert in the effect; the custom web inspector applies it.
      .selectField("preset", 0, state::SecondaryInput,
                   {{"Custom", 0}, {"Modern Prime", 1}, {"Vintage", 2},
                    {"Anamorphic", 3}, {"Dreamy", 4}, {"Clinical", 5}},
                   false, "A named lens look. Applied from the UI (sets the "
                   "character params below); the effect itself only stores it.")
        .label("Preset", "Preset")

      .group("focus", "Depth of Field")
        .groupHelp(
          "The blur itself. *Blur Amount* is the circle-of-confusion radius (how "
          "much out-of-focus areas spread). *Field Curvature* keeps the centre "
          "sharp while softening the corners (Petzval — that vintage 3D pop). "
          "*Focus Centre* moves where the field is sharpest.")
      .floatField("blur_amount", 0.16f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Circle-of-confusion radius (fraction of the frame's short side).").label("Blur Amount", "Blur")
      .floatField("field_curvature", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Petzval field curvature: sharp centre, softer corners.").label("Field Curvature", "Curve")
      .vec2Field("focus_center", 0.0f, 0.0f, state::PrimaryInput, -1.f, 1.f)
        .label("Focus Centre", "Focus")

      .group("bokeh", "Bokeh Shape")
        .groupHelp(
          "The character of the out-of-focus highlights. *Blades* + *Roundness* "
          "set the aperture polygon (few straight blades = hard hexagons; many "
          "round = creamy discs). *Cat's Eye* squashes bokeh toward the frame edges "
          "(optical vignetting — lemon shapes). *Swirl* + *Anamorphic* give Petzval "
          "swirl and oval bokeh. *Apodize* softens the disc edge (creamy), *Rim* / "
          "*Onion* add the nervous bright-rim and aspheric ring texture. *LoCA* is "
          "longitudinal chromatic fringing on the bokeh.")
      .intField("blades", 7, 3, 14, state::PrimaryInput, 1, nullptr,
                "Aperture blade count (polygon sides).").label("Blades", "Blades")
      .floatField("blade_curvature", 0.15f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "0 = hard N-gon, 1 = perfect circle.").label("Roundness", "Round")
      .floatField("aperture_rotation", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Iris rotation (0..1 → full turn).").label("Iris Rotation", "Iris")
      .floatField("cats_eye", 0.8f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Optical vignetting: bokeh squashed to lemons toward the edges.").label("Cat's Eye", "CatEye")
      .floatField("swirl", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Petzval tangential swirl of the bokeh toward the edges.").label("Swirl", "Swirl")
      .floatField("anamorphic", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Oval (anamorphic) bokeh: stretch horizontal, squeeze vertical.").label("Anamorphic", "Anam")
      .floatField("loca", 0.25f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Longitudinal chromatic aberration — colour fringe on out-of-focus edges.").label("LoCA", "LoCA")
      .floatField("rim", 0.12f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Bright-rim (nervous) bokeh.").label("Rim", "Rim")
      .floatField("onion_ring", 0.06f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Aspheric onion-ring texture inside the discs.").label("Onion Ring", "Onion")
      .floatField("apodize", 0.55f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Creamy centre-weighted disc falloff (raised-cosine apodization).").label("Apodize", "Apod")

      .group("highlight", "Highlights")
        .groupHelp(
          "Highlight energy for the bokeh. *Threshold* sets what counts as a "
          "highlight; *Boost* multiplies its energy so bright points survive the "
          "energy-normalised gather as vivid discs rather than dim smears.")
      .floatField("hl_threshold", 1.0f, 0.f, 2.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Linear luma above which a pixel counts as a highlight.").label("HL Threshold", "HL Thr")
      .floatField("hl_boost", 0.375f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Extra energy given to highlights (0..1 → 0..8×).").label("HL Boost", "HL Boost")

      .group("coating", "Coating & Colour")
        .groupHelp(
          "The lens coating: its colour cast and how it flares. *SMC* is a clean "
          "modern multicoat; *Single* / *Uncoated* are warmer, flarier vintage "
          "glass. *Warmth* and *Transmission* trim the overall tone and brightness.")
      .selectField("coating", 0, state::PrimaryInput,
                   {{"SMC", 0}, {"Single", 1}, {"Uncoated", 2}, {"Custom", 3}},
                   false, "Coating stack: drives colour cast, flare colour and amount.").label("Coating", "Coat")
      .floatField("warmth", 0.0f, -1.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Bipolar colour warmth (− cool / + warm).").label("Warmth", "Warm")
      .floatField("transmission", 1.0f, 0.5f, 1.5f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Overall light throughput multiplier.").label("Transmission", "Trans")

      .group("flare", "Flare & Glare")
        .groupHelp(
          "In-frame veiling glare: bright sources within the frame scatter into a "
          "wide, coating-tinted bloom that lifts the blacks (that hazy backlit "
          "look). *Hood Extension* at 1 is a clean shaded lens; retracting it "
          "(toward 0) lets the glare in.")
      .floatField("flare_strength", 0.5f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "In-frame veiling glare amount.").label("Veiling Glare", "Glare")
      .floatField("hood_extension", 1.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "1 = shaded/clean, 0 = retracted (flary).").label("Hood Extension", "Hood")
      .floatField("hood_shape", 0.3f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "0 = cylindrical hood, 1 = petal (admits more on diagonals).").label("Hood Shape", "Petal")

      .group("sun", "Sun / Stray Light")
        .groupHelp(
          "An off-frame bright source (the sun just outside the shot) refracting "
          "through the glass — the showpiece. *Intensity* is the master (0 = off). "
          "*Azimuth* / *Obliqueness* place the source. It manifests as a veil "
          "pedestal, a broad *Glow* toward the source, thin diffraction *Streaks* "
          "locked to the aperture blades, and a *Ghost* chain of aperture-shaped "
          "reflections along the source→centre axis. *Dispersion* spreads the "
          "spectrum for rainbow fringing.")
      .floatField("sun_intensity", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Off-frame source brightness. 0 = the whole sun stack is skipped.").label("Sun Intensity", "Sun")
      .floatField("sun_azimuth", 0.0955f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Direction to the source (0..1 → full turn).").label("Sun Azimuth", "Azim")
      .floatField("sun_obliqueness", 0.35f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "0 = grazing the frame edge, 1 = far off-axis.").label("Obliqueness", "Obliq")
      .rgbField("sun_color", 1.0f, 0.85f, 0.6f, state::SecondaryInput).label("Sun Colour", "SunCol")
      .floatField("sun_veil", 0.6f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Near-flat veiling pedestal.").label("Sun Veil", "Veil")
      .floatField("sun_glow", 0.7f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Broad directional scatter toward the source.").label("Sun Glow", "SunGlow")
      .floatField("sun_streak", 0.18f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Diffraction sunstar spikes on the aperture blades.").label("Sun Streak", "Streak")
      .floatField("sun_ghost", 0.15f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Aperture-shaped internal-reflection ghost chain.").label("Sun Ghost", "Ghost")
      .floatField("element_curvature", 0.45f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Ghost focus / edge definition.").label("Element Curve", "ElemC")
      .floatField("dispersion", 0.35f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Per-wavelength radial spread (spectral fringing).").label("Dispersion", "Disp")

      .group("glow", "Halation & Bloom")
        .groupHelp(
          "Filmic highlight glow. *Halation* is a warm wide ring (the red-ish "
          "bleed film gets around bright edges); *Bloom* is a gentle neutral "
          "spread. Both bleed from the highlights.")
      .floatField("halation", 0.22f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Warm highlight bleed (wide ring).").label("Halation", "Halo")
      .rgbField("halation_color", 1.0f, 0.4f, 0.22f, state::SecondaryInput).label("Halation Colour", "HaloCol")
      .floatField("bloom", 0.12f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Neutral highlight bloom (gentle spread).").label("Bloom", "Bloom")

      .group("geometry", "Distortion")
        .groupHelp(
          "Lens geometry. *Distortion* bends straight lines (− barrel / + "
          "pincushion); *Mustache* adds the higher-order wave. *Chromatic "
          "Aberration* magnifies red/blue oppositely so high-contrast edges fringe "
          "red/cyan toward the corners.")
      .floatField("distortion", 0.0f, -1.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Radial distortion (− barrel / + pincushion).").label("Distortion", "Dist")
      .floatField("distortion_wave", 0.0f, -1.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Higher-order mustache distortion term.").label("Mustache", "Wave")
      .floatField("tca", 0.0f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Transverse chromatic aberration (edge red/cyan fringing).").label("Chromatic Aberration", "TCA")

      .group("finish", "Finish")
        .groupHelp(
          "The film-back. *Exposure* is stops of gain. *Vignette* darkens the "
          "corners. *HL Desat* rolls clipped highlights toward white (no neon "
          "cores). *Tone* blends Reinhard→ACES filmic; *Black* crushes the toe. "
          "*Grain* adds fine film noise. This stage always runs — it produces the "
          "final image.")
      .floatField("exposure", 0.0f, -1.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Exposure in stops (−1..+1 → ÷8..×8).").label("Exposure", "Exp")
      .floatField("mech_vignette", 0.25f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Mechanical corner falloff (cos⁴-ish).").label("Vignette", "Vig")
      .floatField("hl_desat", 0.6f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Highlight desaturation toward white.").label("HL Desat", "Desat")
      .floatField("tone", 0.85f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Tonemap: 0 = Reinhard, 1 = full ACES filmic.").label("Tone", "Tone")
      .floatField("tone_black", 0.02f, 0.f, 1.f, state::SecondaryInput, nullptr, 0.01f,
                  nullptr, "Filmic toe crush (lift/clip the blacks).").label("Black Point", "Black")
      .floatField("grain", 0.05f, 0.f, 1.f, state::PrimaryInput, nullptr, 0.01f,
                  nullptr, "Fine film grain.").label("Grain", "Grain")

      .group("quality", "Quality")
        .groupHelp(
          "Cost/quality. *Quality* picks a preset tier (tap count, downsample, "
          "spectral bands). The advanced overrides tune the gather directly: "
          "*Taps* trades quality for speed, *Work Radius* caps the working-res "
          "blur before it downsamples, *Fill* is a tiny anti-stipple smooth.")
      .selectField("quality", 1, state::SecondaryInput,
                   {{"Cheap", 0}, {"Standard", 1}, {"Max", 2}},
                   false, "Quality tier: tap count, gather downsample, spectral band count.").label("Quality", "Qual")
      .intField("taps", 96, 16, 192, state::SecondaryInput, 1, nullptr,
                "Bokeh gather tap count (higher = smoother discs, slower).").label("Taps", "Taps")
      .floatField("work_radius", 11.0f, 4.f, 24.f, state::SecondaryInput, nullptr, 0.5f, "px",
                  "Max working-res CoC before the gather downsamples.").label("Work Radius", "WorkR")
      .floatField("fill", 0.7f, 0.f, 2.f, state::SecondaryInput, nullptr, 0.05f, "px",
                  "Working-res micro-blur that hides tap stipple.").label("Fill", "Fill")

      .group("debug", "Debug")
        .groupHelp(
          "Inspection aids. *Debug View* replaces the output with an internal "
          "stage — the highlight mask, the circle-of-confusion field, the isolated "
          "bokeh, or the isolated flare.")
      .selectField("debug_view", 0, state::SecondaryInput,
                   {{"Off", 0}, {"Highlight Mask", 1}, {"CoC Field", 2},
                    {"Bokeh Only", 3}, {"Flare Only", 4}},
                   true, "Visualize an internal stage instead of the composited output.").label("Debug View", "Debug")

      .endGroup()
      .capability(state::Capability::TimeIndependent)
      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput));

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("lens_finish", FINISH_SPV, FINISH_SPV_SIZE, "rgba8unorm", "write");
  auto cs_finish = gpu::Device::createShaderModuleByName("lens_finish");
  if (!cs_finish) {
    state::log("lens: finish shader failed to compile");
    return;
  }
  s_pso_finish = gpu::Device::createComputePSO(cs_finish, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8));
  if (!s_pso_finish.valid()) state::log("lens: finish PSO INVALID");
  state::log("lens: module_init done");
}

void* create() {
  auto* s = new State();
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = s_pso_finish.valid();
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
    if      (state::pathIs(p, l, "preset"))            s->preset = state::patchInt(i);
    else if (state::pathIs(p, l, "blur_amount"))       s->blur_amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "field_curvature"))   s->field_curvature = state::patchFloat(i);
    else if (state::pathIs(p, l, "focus_center"))    { auto v = state::patchVec2(i); s->focus_cx = v.x; s->focus_cy = v.y; }
    else if (state::pathIs(p, l, "blades"))            s->blades = state::patchInt(i);
    else if (state::pathIs(p, l, "blade_curvature"))   s->blade_curvature = state::patchFloat(i);
    else if (state::pathIs(p, l, "aperture_rotation")) s->aperture_rotation = state::patchFloat(i);
    else if (state::pathIs(p, l, "cats_eye"))          s->cats_eye = state::patchFloat(i);
    else if (state::pathIs(p, l, "swirl"))             s->swirl = state::patchFloat(i);
    else if (state::pathIs(p, l, "anamorphic"))        s->anamorphic = state::patchFloat(i);
    else if (state::pathIs(p, l, "loca"))              s->loca = state::patchFloat(i);
    else if (state::pathIs(p, l, "rim"))               s->rim = state::patchFloat(i);
    else if (state::pathIs(p, l, "onion_ring"))        s->onion_ring = state::patchFloat(i);
    else if (state::pathIs(p, l, "apodize"))           s->apodize = state::patchFloat(i);
    else if (state::pathIs(p, l, "hl_threshold"))      s->hl_threshold = state::patchFloat(i);
    else if (state::pathIs(p, l, "hl_boost"))          s->hl_boost = state::patchFloat(i);
    else if (state::pathIs(p, l, "coating"))           s->coating = state::patchInt(i);
    else if (state::pathIs(p, l, "warmth"))            s->warmth = state::patchFloat(i);
    else if (state::pathIs(p, l, "transmission"))      s->transmission = state::patchFloat(i);
    else if (state::pathIs(p, l, "flare_strength"))    s->flare_strength = state::patchFloat(i);
    else if (state::pathIs(p, l, "hood_extension"))    s->hood_extension = state::patchFloat(i);
    else if (state::pathIs(p, l, "hood_shape"))        s->hood_shape = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_intensity"))     s->sun_intensity = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_azimuth"))       s->sun_azimuth = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_obliqueness"))   s->sun_obliqueness = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_color"))       { auto v = state::patchVec3(i); s->sun_r = v.x; s->sun_g = v.y; s->sun_b = v.z; }
    else if (state::pathIs(p, l, "sun_veil"))          s->sun_veil = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_glow"))          s->sun_glow = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_streak"))        s->sun_streak = state::patchFloat(i);
    else if (state::pathIs(p, l, "sun_ghost"))         s->sun_ghost = state::patchFloat(i);
    else if (state::pathIs(p, l, "element_curvature")) s->element_curvature = state::patchFloat(i);
    else if (state::pathIs(p, l, "dispersion"))        s->dispersion = state::patchFloat(i);
    else if (state::pathIs(p, l, "halation"))          s->halation = state::patchFloat(i);
    else if (state::pathIs(p, l, "halation_color"))  { auto v = state::patchVec3(i); s->hal_r = v.x; s->hal_g = v.y; s->hal_b = v.z; }
    else if (state::pathIs(p, l, "bloom"))             s->bloom = state::patchFloat(i);
    else if (state::pathIs(p, l, "distortion"))        s->distortion = state::patchFloat(i);
    else if (state::pathIs(p, l, "distortion_wave"))   s->distortion_wave = state::patchFloat(i);
    else if (state::pathIs(p, l, "tca"))               s->tca = state::patchFloat(i);
    else if (state::pathIs(p, l, "exposure"))          s->exposure = state::patchFloat(i);
    else if (state::pathIs(p, l, "mech_vignette"))     s->mech_vignette = state::patchFloat(i);
    else if (state::pathIs(p, l, "hl_desat"))          s->hl_desat = state::patchFloat(i);
    else if (state::pathIs(p, l, "tone"))              s->tone = state::patchFloat(i);
    else if (state::pathIs(p, l, "tone_black"))        s->tone_black = state::patchFloat(i);
    else if (state::pathIs(p, l, "grain"))             s->grain = state::patchFloat(i);
    else if (state::pathIs(p, l, "quality"))           s->quality = state::patchInt(i);
    else if (state::pathIs(p, l, "taps"))              s->taps = state::patchInt(i);
    else if (state::pathIs(p, l, "work_radius"))       s->work_radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "fill"))              s->fill = state::patchFloat(i);
    else if (state::pathIs(p, l, "debug_view"))        s->debug_view = state::patchInt(i);
  }
}

void on_resolume_param(void* self, long long, double) { (void)self; }

// Conservative whole-effect passthrough. The finish stage normally transforms
// (tonemap), so identity requires an explicitly-neutral config. STAGE 1's render
// is a straight copy regardless; this predicate is refined when the real finish
// lands. Stateless (TimeIndependent) — safe to skip.
static inline bool near0(float x) { return x > -1e-4f && x < 1e-4f; }
int32_t is_identity(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return 0;
  bool optics_off = near0(s->blur_amount) && near0(s->hl_boost) &&
                    near0(s->sun_intensity) && near0(s->flare_strength) &&
                    near0(s->halation) && near0(s->bloom) &&
                    near0(s->distortion) && near0(s->distortion_wave) && near0(s->tca);
  bool color_off  = (s->coating == 3) && near0(s->warmth) &&
                    (s->transmission > 1.f - 1e-4f && s->transmission < 1.f + 1e-4f);
  bool finish_off = near0(s->exposure) && near0(s->mech_vignette) &&
                    near0(s->hl_desat) && near0(s->grain) && near0(s->tone);
  return (optics_off && color_off && finish_off) ? 1 : 0;
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  const int gx = (vp_w + 7) / 8, gy = (vp_h + 7) / 8;

  // STAGE 1: passthrough copy.
  { auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_finish);
    cp.setTexture(in, 0, 0); cp.setTexture(out, 1, 1);
    cp.dispatch(gx, gy); cp.end(); }

  gpu::Device::submit();
}

} // namespace lens
