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
 * STAGE 2 (current): prepare (sRGB→linear + highlight boost) → bokeh gather
 * (full-res Vogel-disc shaped-aperture gather with cats-eye/swirl/anamorphic/
 * field-curvature/LoCA) → finish (exposure/vignette/hl-desat/tonemap/grain). The
 * downsample tier, the `fill` anti-stipple blur, coating/flare/glow/geo, and the
 * spec-constant quality tiers land in later stages.
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

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace lens {

// --- baked coating table (coatings.py:41-55) ----------------------------------
// tint, transmission, contrast, loca, rim, onion, flare, flare_tint, coat
// designs (≤3 wavelengths nm) + count, coat_r0. Indexed by the `coating` select.
struct Coating {
  float tint[3];
  float transmission, contrast;
  float loca, rim, onion, flare;
  float flare_tint[3];
  float designs[3]; int ndesigns;
  float r0;
};
static const Coating COATINGS[4] = {
  // SMC
  {{0.99f,1.00f,1.01f}, 1.00f,1.06f, 0.30f,0.20f,0.10f,0.18f, {0.55f,0.75f,1.00f}, {455.f,545.f,630.f},3, 0.11f},
  // Single
  {{1.05f,1.00f,0.92f}, 0.92f,0.96f, 0.70f,0.60f,0.40f,0.60f, {1.00f,0.80f,0.50f}, {535.f,0.f,0.f},1, 0.24f},
  // Uncoated
  {{1.10f,1.00f,0.84f}, 0.82f,0.86f, 1.00f,1.00f,0.70f,1.00f, {1.00f,0.86f,0.60f}, {0.f,0.f,0.f},0, 0.42f},
  // Custom
  {{1.00f,1.00f,1.00f}, 1.00f,1.00f, 1.00f,1.00f,1.00f,1.00f, {1.00f,1.00f,1.00f}, {500.f,0.f,0.f},1, 0.16f},
};
static inline const Coating& coatingOf(int i) { return COATINGS[(i < 0 || i > 3) ? 3 : i]; }

// --- shader-portable helpers (mirror optics.py) -------------------------------
static inline float ss(float e0, float e1, float x) {
  float t = (x - e0) / (e1 - e0);
  t = t < 0.f ? 0.f : (t > 1.f ? 1.f : t);
  return t * t * (3.f - 2.f * t);
}
static inline float ss_down(float edge, float x, float soft) {
  float w = edge * soft; if (w < 1e-4f) w = 1e-4f;
  float t = (x - (edge - w)) / (2.f * w);
  t = t < 0.f ? 0.f : (t > 1.f ? 1.f : t);
  return 1.f - t * t * (3.f - 2.f * t);
}
// optics.poly_boundary_radius (blades polygon, circumradius 1).
static inline float polyBoundaryR(float theta, int blades, float rot, float curv) {
  int n = blades < 3 ? 3 : blades;
  float sector = 2.f * (float)M_PI / n;
  float a = theta - rot;
  float rem = a - std::floor(a / sector) * sector;   // torch.remainder
  float phi = rem - sector * 0.5f;
  float apo = std::cos((float)M_PI / n);
  float cp = std::cos(phi); if (cp < 1e-4f) cp = 1e-4f;
  float poly_r = apo / cp;
  return poly_r + (1.f - poly_r) * curv;             // lerp(poly_r, 1, curv)
}

// --- per-pass uniform layouts (16-byte rows) ----------------------------------
struct PrepareU { float hl_threshold, hl_boost, _p0, _p1; };
static_assert(sizeof(PrepareU) == 16, "PrepareU layout");

struct BokehU {
  float half, dimw, dimh, coc_px;
  float field_curv, focus_cx, focus_cy, cats_eye;
  float swirl, anamorphic, loca_scale; uint32_t taps;
};
static_assert(sizeof(BokehU) == 48, "BokehU layout");

struct FinishU {
  float half, dimw, dimh, exposure;
  float vignette, hl_desat, tone, tone_black;
  float grain, _p0, _p1, _p2;
};
static_assert(sizeof(FinishU) == 48, "FinishU layout");

static constexpr int MAX_TAPS = 192;

// --- per-instance state -------------------------------------------------------
struct State {
  int  tex_w = 0, tex_h = 0;
  bool initialized = false;

  // GPU resources (per-instance).
  gpu::Texture bufA, bufB;       // full-res linear-HDR ping/pong
  gpu::Sampler sampler;          // Linear/ClampToEdge (bokeh taps)
  gpu::Buffer  tap_buf;          // Vogel tap set (float4/tap: ox,oy,base_w,_)
  gpu::Buffer  prepare_buf, bokeh_buf, finish_buf;

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
// NOTE: fx::GaussianBlur is NOT usable on RGBA16F intermediates (its scratch is
// RGBA8, which clamps HDR — see line_reconstruct's Blur16). The `fill` anti-
// stipple micro-blur is deferred until an RGBA16F-safe blur is wired for the
// flare/glow passes.
static gpu::ComputePSO s_pso_prepare, s_pso_bokeh, s_pso_finish;

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

  const auto F16 = gpu::TextureFormat::RGBA16F;
  state::registerShaderSPV("lens_prepare", PREPARE_SPV, PREPARE_SPV_SIZE, "rgba16float", "write");
  state::registerShaderSPV("lens_bokeh",   BOKEH_SPV,   BOKEH_SPV_SIZE,   "rgba16float", "write");
  state::registerShaderSPV("lens_finish",  FINISH_SPV,  FINISH_SPV_SIZE,  "rgba8unorm",  "write");
  auto cs_prepare = gpu::Device::createShaderModuleByName("lens_prepare");
  auto cs_bokeh   = gpu::Device::createShaderModuleByName("lens_bokeh");
  auto cs_finish  = gpu::Device::createShaderModuleByName("lens_finish");
  if (!cs_prepare || !cs_bokeh || !cs_finish) {
    state::log("lens: a shader failed to compile");
    return;
  }
  s_pso_prepare = gpu::Device::createComputePSO(cs_prepare, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, F16).uniform(2));
  s_pso_bokeh = gpu::Device::createComputePSO(cs_bokeh, "main", gpu::Bindings()
      .tex2d(0).storage(1).sampler(2).storageTex2d(3, F16).uniform(4));
  s_pso_finish = gpu::Device::createComputePSO(cs_finish, "main", gpu::Bindings()
      .tex2d(0).storageTex2d(1, gpu::TextureFormat::RGBA8).uniform(2));

  gpu::ComputePSO* psos[] = { &s_pso_prepare, &s_pso_bokeh, &s_pso_finish };
  for (auto* p : psos) if (!p->valid()) state::log("lens: a PSO is INVALID");
  state::log("lens: module_init done");
}

void* create() {
  auto* s = new State();
  s->sampler = gpu::Device::createSampler(gpu::FilterMode::Linear, gpu::AddressMode::ClampToEdge);
  s->tap_buf = gpu::Device::createBuffer(sizeof(float) * 4 * MAX_TAPS, gpu::BufferUsage::Storage);
  s->prepare_buf = gpu::Device::createBuffer(sizeof(PrepareU), gpu::BufferUsage::Uniform);
  s->bokeh_buf   = gpu::Device::createBuffer(sizeof(BokehU),   gpu::BufferUsage::Uniform);
  s->finish_buf  = gpu::Device::createBuffer(sizeof(FinishU),  gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  if (s->bufA.valid()) s->bufA.release();
  if (s->bufB.valid()) s->bufB.release();
  s->sampler.release();
  s->tap_buf.release();
  s->prepare_buf.release();
  s->bokeh_buf.release();
  s->finish_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = s_pso_prepare.valid() && s_pso_bokeh.valid() &&
                   s_pso_finish.valid() &&
                   s->tap_buf.valid() && s->finish_buf.valid();
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

static bool ensureTextures(State* s, int w, int h) {
  if (s->tex_w == w && s->tex_h == h && s->bufA.valid() && s->bufB.valid()) return true;
  if (s->bufA.valid()) s->bufA.release();
  if (s->bufB.valid()) s->bufB.release();
  s->bufA = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA16F);
  s->bufB = gpu::Device::createTexture(w, h, gpu::TextureFormat::RGBA16F);
  if (!s->bufA.valid() || !s->bufB.valid()) return false;
  s->tex_w = w; s->tex_h = h;
  return true;
}

// Rebuild the Vogel tap set + its pixel-independent weight (aperture · rim ·
// apodization) into the tap storage buffer (pipeline.pass_bokeh :183-190;
// optics.py). Recomputed per frame — K≤192 cheap trig on the CPU.
static void writeTaps(State* s) {
  const Coating& coat = coatingOf(s->coating);
  int K = s->taps; if (K < 1) K = 1; if (K > MAX_TAPS) K = MAX_TAPS;
  const float ga = (float)M_PI * (3.f - std::sqrt(5.f));   // golden angle
  const float rot = s->aperture_rotation * (float)(2.0 * M_PI);
  const float rimv   = s->rim * coat.rim;
  const float onionv = s->onion_ring * coat.onion;
  float buf[4 * MAX_TAPS];
  for (int k = 0; k < K; k++) {
    float r = std::sqrt((k + 0.5f) / K);
    float t = k * ga;
    float ox = r * std::cos(t), oy = r * std::sin(t);
    float theta = std::atan2(oy, ox);
    float bnd = polyBoundaryR(theta, s->blades, rot, s->blade_curvature);
    float aw = ss_down(bnd, r, 0.05f);
    float u = r < 0.f ? 0.f : (r > 1.f ? 1.f : r);
    float edge = ss(0.55f, 1.0f, u);
    float rw = 1.f + rimv * edge;
    if (onionv != 0.f)
      rw += onionv * 0.5f * (0.5f - 0.5f * std::cos(u * 5.f * (float)M_PI)) * u;
    float apod = (1.f - s->apodize) + s->apodize * (0.5f + 0.5f * std::cos((float)M_PI * u));
    buf[4 * k + 0] = ox;
    buf[4 * k + 1] = oy;
    buf[4 * k + 2] = aw * rw * apod;
    buf[4 * k + 3] = 0.f;
  }
  s->tap_buf.writeBytes(buf, sizeof(float) * 4 * K, 0);
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;
  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  if (!ensureTextures(s, vp_w, vp_h)) return;

  const int gx = (vp_w + 7) / 8, gy = (vp_h + 7) / 8;
  const float md0  = (float)(vp_w < vp_h ? vp_w : vp_h);
  const float coc_px0 = s->blur_amount * md0 * 0.25f;
  const float half = (float)(vp_w > vp_h ? vp_w : vp_h) * 0.5f;

  // 1. prepare: sRGB→linear + highlight boost → bufA (linear HDR).
  { PrepareU u = { s->hl_threshold, s->hl_boost * 8.f, 0.f, 0.f };
    s->prepare_buf.writeOne(u);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_prepare);
    cp.setTexture(in, 0, 0); cp.setTexture(s->bufA, 1, 1);
    cp.setBuffer(s->prepare_buf, 2);
    cp.dispatch(gx, gy); cp.end(); }

  gpu::Texture cur = s->bufA;

  // 2. bokeh gather (full-res for now) → bufB. Skip at ~zero blur.
  if (coc_px0 > 0.5f) {
    writeTaps(s);
    BokehU u = {};
    u.half = half; u.dimw = (float)vp_w; u.dimh = (float)vp_h;
    u.coc_px = coc_px0;
    u.field_curv = s->field_curvature;
    u.focus_cx = s->focus_cx; u.focus_cy = s->focus_cy;
    u.cats_eye = s->cats_eye; u.swirl = s->swirl; u.anamorphic = s->anamorphic;
    u.loca_scale = s->loca * coatingOf(s->coating).loca;
    u.taps = (uint32_t)(s->taps < 1 ? 1 : (s->taps > MAX_TAPS ? MAX_TAPS : s->taps));
    s->bokeh_buf.writeOne(u);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_bokeh);
    cp.setTexture(s->bufA, 0, 0); cp.setBuffer(s->tap_buf, 1);
    cp.setSampler(s->sampler, 2);
    cp.setTexture(s->bufB, 3, 1); cp.setBuffer(s->bokeh_buf, 4);
    cp.dispatch(gx, gy); cp.end();
    // (fill anti-stipple blur deferred — needs an RGBA16F-safe blur.)
    cur = s->bufB;
  }

  // 8. finish: exposure → vignette → hl_desat → tonemap → sRGB → grain → tex_out.
  { FinishU u = {};
    u.half = half; u.dimw = (float)vp_w; u.dimh = (float)vp_h;
    u.exposure = std::pow(2.f, 3.f * s->exposure);
    u.vignette = s->mech_vignette; u.hl_desat = s->hl_desat;
    u.tone = s->tone; u.tone_black = s->tone_black; u.grain = s->grain;
    s->finish_buf.writeOne(u);
    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso_finish);
    cp.setTexture(cur, 0, 0); cp.setTexture(out, 1, 1);
    cp.setBuffer(s->finish_buf, 2);
    cp.dispatch(gx, gy); cp.end(); }

  gpu::Device::submit();
}

} // namespace lens
