/*
 * source.mesh.three_planes — three isometric planes stacked like a 3D chess
 * board, shaded as VCR-era neon.
 *
 * Built for the "Layer^3" show (a three-floor venue). Everything rhythmic is
 * driven from OUTSIDE: the host wires per-plane emission / fill / colour, and
 * sweeps the orbit azimuth on an envelope. This effect just renders the stack
 * beautifully and publishes the screen-space rails the rest of the rig needs.
 *
 * Architecture: the CPU projects 12 corner points per frame (orthographic, so
 * the projection is a plain affine map — no perspective divide, no near
 * plane), and ONE fullscreen compute pass does all the shading from an exact
 * SDF. See render.hlsl for why this beats rasterising the quads.
 *
 * The camera math is deliberately viewport-INDEPENDENT: cover-square coords
 * are already aspect-normalised, so the projected geometry and both published
 * rails can be computed in tick() with no viewport and no GPU readback.
 */

#include <gpu.h>
#include <host.h>
#include <val.h>
#include <effect_utils.h>   // fx::coverSquare
#include <sketch/three_planes_glints.h>
#include "three_planes_shaders.h"

#include <cmath>
#include <cstdint>

namespace three_planes {

static constexpr int PLANES = 3;
static constexpr float kPi = 3.14159265358979323846f;

// True isometric: the deck tilt where a unit cube's three visible faces
// project to equal areas. Our default elevation.
static const float kIsoElevationDeg = 35.264389682754654f;

// Mirrors `cbuffer Uniforms` in render.hlsl, row for row.
struct Uniforms {
  float corners[6][4];      // rows 0-5:  plane i -> rows 2i, 2i+1
  float plane_color[3][4];  // rows 6-8:  rgb = colour, w = emission drive
  float fills[4];           // row  9:    xyz = signed fill per plane
  float neon0[4];           // row 10:    line half-width, line gain, whiten, halo r
  float neon1[4];           // row 11:    halo gain, falloff, corner r, aa width
  float misc[4];            // row 12:    fill gain, chroma bleed, input opacity, debug
  float view[4];            // row 13:    vp_w, vp_h, aspect_x, aspect_y
  float glim0[4];           // row 14:    travel dir x, dir y, -, -
  // One row per glint IN FLIGHT: where it is on the travel axis (cover-square),
  // its half-width there, and the two look values it was born with. A dead slot
  // is zero gain and zero shade, so the shader needs no count and no branch.
  float glints[8][4];       // rows 15-22: axis, half-width, gain, shade
  float grade[16];          // rows 23-26: VcrGrade
};
static_assert(sizeof(Uniforms) == 432, "Uniforms layout mismatch with render.hlsl");
static_assert(three_planes_glints::kMaxLive == 8, "glint rows must match kMaxLive");

struct State {
  // --- Planes (the externally-driven rhythm surface) ---
  float emission[PLANES] = {0.85f, 0.85f, 0.85f};
  float fill[PLANES]     = {0.0f, 0.0f, 0.0f};
  float color[PLANES][3] = {{1.00f, 0.22f, 0.62f},   // magenta  (bottom)
                            {0.30f, 0.85f, 1.00f},   // cyan     (middle)
                            {0.72f, 0.35f, 1.00f}};  // violet   (top)

  // --- Camera ---
  float orbit_azimuth = 0.125f;              // [0,1] -> 0..360 deg; 0.125 = 45 deg
  float elevation_deg = kIsoElevationDeg;
  float zoom          = 0.55f;
  float plane_spacing = 0.42f;
  float plane_size    = 0.62f;
  float corner_radius = 0.012f;

  // --- Neon ---
  float line_width   = 0.18f;
  float line_gain    = 1.60f;
  float core_whiten  = 0.85f;
  float halo_radius  = 0.30f;
  float halo_gain    = 0.55f;
  float halo_falloff = 0.45f;
  float halo_smooth  = 0.35f;
  float fill_gain    = 0.22f;

  // --- Glimmer ---
  // The rhythm still comes from outside — `glimmer_drive` is the rig's Sweep
  // knob — but the glints themselves are PARTICLES with lifetimes, so unlike
  // everything else in this effect they are an accumulator. See
  // <sketch/three_planes_glints.h>; it is why the effect is only
  // SeekableApproximate rather than TimeIndependent.
  three_planes_glints::Core glint_core;
  float glimmer_drive   = 0.0f;    // 0..1 spawn + speed drive, wired from the rig
  float glimmer_density = 5.0f;    // arrivals per second at full drive
  float glimmer_speed   = 1.2f;    // crossings per second at full drive
  float glimmer_angle   = 45.0f;   // degrees, travel direction, CCW from +x
  float glimmer_width   = 0.07f;   // glint half-width, fraction of the travel span
  float glimmer_gain    = 1.6f;
  float glimmer_shadow  = 0.55f;

  // --- Grade ---
  float exposure        = 1.0f;
  float warmth          = 0.35f;
  float drive           = 0.35f;
  float asymmetry       = 0.20f;
  float toe             = 0.25f;
  float shoulder        = 0.50f;
  float highlight_desat = 0.70f;
  float highlight_tint[3] = {1.00f, 0.22f, 0.62f};
  float highlight_tint_amount = 0.0f;
  float highlight_tint_pivot  = 1.0f;
  float chroma_bleed    = 0.25f;
  float scanline        = 0.12f;
  int   scanline_count  = 240;
  float grain           = 0.08f;
  float input_opacity   = 1.0f;

  // --- Debug ---
  bool debug_show_sdf    = false;
  bool debug_show_planes = false;

  // --- Derived, recomputed each tick ---
  float corner_x[PLANES][4] = {};
  float corner_y[PLANES][4] = {};
  float plane_y[PLANES]     = {};
  float plane_half_h[PLANES]= {};

  bool initialized = false;
  gpu::Buffer uniform_buf;
};

static gpu::ComputePSO s_pso;

// --- Perceptual mappings (style guide 1.3) --------------------------------
// Every one of these takes a normalised slider and returns the value the
// shader actually wants, so the UI stays in [0,1] and taps compose.

// Emission: a dimmer curve. Slightly steeper than linear so the bottom of the
// range stays dark and the top has real punch to blow the cores out.
static inline float emissionDrive(float e) {
  return std::pow(e < 0.0f ? 0.0f : e, 1.8f) * 3.2f;
}
// Line half-width in cover-square units: 0.0012 .. 0.022, quadratic so the
// hairline end of the range gets most of the slider.
static inline float lineHalfWidth(float w) {
  float t = w < 0.0f ? 0.0f : (w > 1.0f ? 1.0f : w);
  return 0.0012f + 0.0208f * t * t;
}
// Halo radius: exponential, 0.006 .. 0.24 cover-square units.
static inline float haloRadius(float r) {
  float t = r < 0.0f ? 0.0f : (r > 1.0f ? 1.0f : r);
  return 0.006f * std::pow(40.0f, t);
}

// How far a glint's drawn profile reaches on either side of its centre, in its
// own half-widths. Mirrors render.hlsl: the super-Gaussian core has died by
// about 1.5, and the Gaussian wake trailing it by about 5.5.
//
// Deliberately asymmetric, because the two margins are doing different jobs.
// The entry margin only has to hide the core's leading edge so the glint fades
// in rather than popping; the exit margin has to let the whole wake finish
// crossing before the glint is retired.
static constexpr float kGlintSkirt = 1.5f;
static constexpr float kGlintWakeReach = 5.5f;

// --- Camera ---------------------------------------------------------------
// Planes are squares in the model XZ plane at y = -spacing, 0, +spacing. The
// origin IS the middle plane's centre, so orbiting about it is free.
//
//   azimuth theta about Y, then elevation phi tilts the deck. Orthographic,
//   so this is one affine map — corners project exactly, no divide.
//
// Cover-square y grows DOWNWARD (uv.y is 0 at the top), hence the negations.
static void projectPlanes(State& s) {
  const float th = s.orbit_azimuth * 2.0f * kPi;
  const float ph = s.elevation_deg * (kPi / 180.0f);
  const float ct = std::cos(th), st = std::sin(th);
  const float cp = std::cos(ph), sp = std::sin(ph);
  const float half = s.plane_size;

  // Model-space corners of a square in XZ, wound consistently.
  const float cx[4] = {-half, +half, +half, -half};
  const float cz[4] = {-half, -half, +half, +half};

  for (int i = 0; i < PLANES; i++) {
    const float y = (float(i) - 1.0f) * s.plane_spacing;   // 0 = bottom floor
    for (int k = 0; k < 4; k++) {
      const float xr =  cx[k] * ct - cz[k] * st;
      const float zr =  cx[k] * st + cz[k] * ct;
      s.corner_x[i][k] = xr * s.zoom;
      s.corner_y[i][k] = (-y * cp - zr * sp) * s.zoom;
    }
    // The plane's CENTRE sits on the orbit axis (x = z = 0), so its screen Y
    // is a pure function of elevation and zoom — azimuth cannot move it.
    // That is what makes this rail stable enough to composite against.
    s.plane_y[i] = -y * cp * s.zoom;
    // Silhouette half-height DOES swing with azimuth: max |zr| over the four
    // corners is half * (|sin| + |cos|).
    s.plane_half_h[i] =
        sp * s.zoom * half * (std::fabs(st) + std::fabs(ct));
  }
}

static void publish(const char* name, float value) {
  auto vh = val::number(value);
  state::setValPath(name, vh);
  val::release(vh);
}

// Both rails are pure functions of the camera params, so publishing them is
// cheap and idempotent. We do it from tick() AND render(): tick() so taps read
// THIS frame's value before it is consumed, render() so a host that renders
// without ticking (thumbnails, off-playhead previews) still gets live rails
// instead of zeros.
static void publishRails(const State& s) {
  publish("plane1_y", s.plane_y[0]);
  publish("plane2_y", s.plane_y[1]);
  publish("plane3_y", s.plane_y[2]);
  publish("plane1_half_h", s.plane_half_h[0]);
  publish("plane2_half_h", s.plane_half_h[1]);
  publish("plane3_half_h", s.plane_half_h[2]);
}

void module_init() {
  state::init("source.mesh.three_planes", {1, 0, 0},
    state::Schema()
      .helpField("intro",
        "## Three Planes\n"
        "Three isometric planes stacked like a 3D chess board, shaded as "
        "VCR-era neon. Built for a three-floor venue, but it reads as a "
        "level meter anywhere.\n\n"
        "Each plane has three states: **empty** (fill 0, just the glowing "
        "outline), **filled** (fill > 0, neon flood) and **masked** "
        "(fill < 0, a black body that eats the glow of everything beneath "
        "it while keeping its own outline). That last one is the whole "
        "trick — it lets the stack read as solid geometry instead of three "
        "transparent overlays.\n\n"
        "**Try:** drive the three *Emission* knobs from an envelope follower "
        "for a peak-holding VU tower — hold the peak plane on a different "
        "*Colour*. Sweep *Orbit Azimuth* slowly under it; the published "
        "`planeN_y` rails stay rock steady while it turns, so anything you "
        "composite on top stays glued to its floor.")

      // ---------------- Planes ----------------
      .group("planes", "Planes")
        .groupHelp(
          "The performance surface — wire all nine of these. **Emission** is "
          "the light coming up, on a dimmer curve. **Fill** is signed: push "
          "it positive to flood the plane with neon, negative to turn it "
          "into a black mask that occludes the planes below. **Colour** is "
          "what the halo carries; the line core always blows out toward "
          "white (see *Core Whiten*).\n\n"
          "Plane 1 is the ground floor, plane 3 the top.")
      .floatField("plane1_emission", 0.85f, 0.f, 1.f, state::PrimaryInput)
        .label("Plane 1 Emission", "P1 Emit")
      .floatField("plane1_fill", 0.0f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Plane 1 Fill", "P1 Fill")
      .rgbField("plane1_color", 1.00f, 0.22f, 0.62f, state::PrimaryInput)
        .label("Plane 1 Colour", "P1 Col")
      .floatField("plane2_emission", 0.85f, 0.f, 1.f, state::PrimaryInput)
        .label("Plane 2 Emission", "P2 Emit")
      .floatField("plane2_fill", 0.0f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Plane 2 Fill", "P2 Fill")
      .rgbField("plane2_color", 0.30f, 0.85f, 1.00f, state::PrimaryInput)
        .label("Plane 2 Colour", "P2 Col")
      .floatField("plane3_emission", 0.85f, 0.f, 1.f, state::PrimaryInput)
        .label("Plane 3 Emission", "P3 Emit")
      .floatField("plane3_fill", 0.0f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Plane 3 Fill", "P3 Fill")
      .rgbField("plane3_color", 0.72f, 0.35f, 1.00f, state::PrimaryInput)
        .label("Plane 3 Colour", "P3 Col")

      // ---------------- Camera ----------------
      .group("camera", "Camera")
        .groupHelp(
          "Orthographic throughout — orbiting never introduces perspective, "
          "so the three planes stay exactly parallel and the stack keeps "
          "reading as a diagram rather than a photograph.\n\n"
          "*Orbit Azimuth* is normalised to [0,1] precisely because it is "
          "meant to be swept from an envelope. *Elevation* defaults to "
          "35.26 deg, the true isometric tilt; drop it toward 0 for a flat "
          "side-on stack, push it up for a top-down board.")
      .floatField("orbit_azimuth", 0.125f, 0.f, 1.f, state::PrimaryInput,
                  "unsigned", 0.f, nullptr,
                  "Turntable angle. 0..1 maps to a full 360 deg turn.")
        .label("Orbit Azimuth", "Orbit")
      .floatField("elevation", kIsoElevationDeg, 0.f, 89.f, state::PrimaryInput,
                  nullptr, 0.f, "deg",
                  "Deck tilt. 35.26 deg is true isometric.")
        .label("Elevation", "Elev")
      .floatField("zoom", 0.55f, 0.05f, 2.f, state::PrimaryInput)
        .label("Zoom", "Zoom")
      .floatField("plane_spacing", 0.42f, 0.f, 1.5f, state::PrimaryInput)
        .label("Plane Spacing", "Space")
      .floatField("plane_size", 0.62f, 0.05f, 1.5f, state::PrimaryInput)
        .label("Plane Size", "Size")
      .floatField("corner_radius", 0.012f, 0.f, 0.25f, state::SecondaryInput)
        .label("Corner Radius", "Corner")

      // ---------------- Neon ----------------
      .group("neon", "Neon & Halo")
        .groupHelp(
          "The halo is analytic — an exponential of the true distance to the "
          "outline — so *Halo Radius* costs nothing to widen and stays "
          "perfectly smooth around corners.\n\n"
          "**Core Whiten** is the knob that decides whether this reads as "
          "neon at all: real neon photographs have a white-hot filament with "
          "the colour surviving only out in the glow. At 0 the line stays "
          "fully tinted and looks like vector art; push it up and the tube "
          "lights.")
      .floatField("line_width", 0.18f, 0.f, 1.f, state::PrimaryInput)
        .label("Line Width", "Width")
      .floatField("line_gain", 1.60f, 0.f, 4.f, state::PrimaryInput)
        .label("Line Gain", "Line")
      .floatField("core_whiten", 0.85f, 0.f, 1.f, state::PrimaryInput)
        .label("Core Whiten", "Whiten")
      .floatField("halo_radius", 0.30f, 0.f, 1.f, state::PrimaryInput)
        .label("Halo Radius", "Halo R")
      .floatField("halo_gain", 0.55f, 0.f, 3.f, state::PrimaryInput)
        .label("Halo Gain", "Halo")
      .floatField("halo_falloff", 0.45f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "0 = tight and punchy, 1 = wide and soft.")
        .label("Halo Falloff", "Fall")
      .floatField("halo_smooth", 0.35f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "Rounds the corner creases just OUTSIDE the outline, as a "
                  "fraction of the halo radius. 0 shows the raw ridge. The "
                  "interior does not use this — it sums the four edges.")
        .label("Halo Smoothing", "Smooth")
      .floatField("fill_gain", 0.22f, 0.f, 2.f, state::SecondaryInput)
        .label("Fill Gain", "Fill G")

      // ---------------- Glimmer ----------------
      .group("glimmer", "Glimmer")
        .groupHelp(
          "Slanted glints that travel across the stack — the glare off metal "
          "in an old cel-animated show.\n\n"
          "They are **particles, not a pattern**: each one is born at a "
          "boundary, crosses the picture and dies at the far side, and while "
          "it is in flight nothing about the knob that threw it reaches it. "
          "Arrivals are randomly spaced and each glint gets its own "
          "brightness, width and wake at birth, so a stream of them reads as "
          "separate events rather than as a moving grating.\n\n"
          "They multiply each plane's **emission**, not the finished picture. "
          "That is the whole trick: emission scales the line core, the halo "
          "and the fill together, so a glint crossing a tube brightens the "
          "glow around it too and reads as light IN the tube rather than a "
          "highlight pasted over it.\n\n"
          "*Drive* is the one live input, and it does exactly two things — "
          "how often glints arrive, and how fast they travel. Wire it from "
          "**Three Planes Rig**'s *Glint* rail and riding the Sweep knob "
          "throws them. At 0 nothing new arrives and whatever is still in "
          "flight coasts out and dies, so an unwired card is quiet.\n\n"
          "They are born just outside the stack and retired just past it, "
          "rather than crossing the whole frame — so one starts working "
          "almost as soon as it is thrown, instead of spending its first "
          "moments out in the black where there is nothing to light.\n\n"
          "Speed is shared by every glint on purpose: at their own speeds "
          "they would eventually cross, and two overlapping glints stop being "
          "two things.\n\n"
          "*Shadow* is what sells it — a dark wake trailing each glint, so "
          "the stack gains contrast rather than just getting brighter.")
      .floatField("glimmer_drive", 0.0f, 0.f, 1.f, state::PrimaryInput,
                  "unsigned", 0.f, nullptr,
                  "How hard the glints are being thrown: arrivals per second "
                  "and travel speed. It never touches a glint already in "
                  "flight.")
        .label("Glint Drive", "Glint")
      .floatField("glimmer_density", 5.0f, 0.f, 16.f, state::PrimaryInput,
                  nullptr, 0.f, "/s",
                  "Arrivals per second at full Drive. At most eight can be in "
                  "flight at once; past that, arrivals are dropped rather "
                  "than cutting a glint short.")
        .label("Glint Rate", "Rate")
      .floatField("glimmer_speed", 1.2f, 0.1f, 6.f, state::PrimaryInput,
                  nullptr, 0.f, "/s",
                  "Crossings per second at full Drive. A crossing is the LIT "
                  "part of the picture, not the whole frame — a glint is born "
                  "just outside the stack and retired just past it, so it "
                  "starts working almost as soon as it is thrown. Never falls "
                  "to zero, so it always reaches the far side.")
        .label("Glint Speed", "Speed")
      .floatField("glimmer_gain", 1.6f, 0.f, 4.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How hard a glint lifts the emission it crosses. Each one "
                  "takes a random share of this at birth.")
        .label("Glint Gain", "GlGain")
      .floatField("glimmer_shadow", 0.55f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "The dark wake trailing each glint, as a fraction of full "
                  "extinction.")
        .label("Glint Shadow", "Shadow")
      .floatField("glimmer_angle", 45.f, 0.f, 360.f, state::SecondaryInput,
                  nullptr, 0.f, "deg",
                  "Which way the glints travel. 45 deg runs bottom-left to "
                  "top-right; each glint sits square across that.")
        .label("Glint Angle", "GlAng")
      .floatField("glimmer_width", 0.07f, 0.01f, 0.4f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "Glint width, as a fraction of the distance it travels — "
                  "so it scales with the stack rather than with the frame. "
                  "Small is a hard slash, large is a soft sheen.")
        .label("Glint Width", "GlWid")

      // ---------------- Grade ----------------
      .group("grade", "Warmth & Dehancement")
        .groupHelp(
          "The analogue tail. *Chroma Bleed* splits R/G/B horizontally the "
          "way a tape transport does — here it is exact, because the whole "
          "stack is re-evaluated at three offsets rather than blurred.\n\n"
          "*Drive* and *Asymmetry* are where warmth actually lives: the "
          "asymmetric bias makes even and odd harmonics unequal instead of "
          "just rounding the peaks. *Highlight Desat* runs before the curve, "
          "in HDR, so hot cores bleach to white properly.\n\n"
          "**Try:** Drive up + Toe up + Scanlines low is a tired VHS dub; "
          "everything near 0 is a clean vector look.")
      .floatField("chroma_bleed", 0.25f, 0.f, 1.f, state::PrimaryInput)
        .label("Chroma Bleed", "Chroma")
      .floatField("warmth", 0.35f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Warmth", "Warm")
      .floatField("drive", 0.35f, 0.f, 1.f, state::PrimaryInput)
        .label("Drive", "Drive")
      .floatField("exposure", 1.0f, 0.f, 2.f, state::PrimaryInput)
        .label("Exposure", "Expo")
      .floatField("asymmetry", 0.20f, -1.f, 1.f, state::SecondaryInput, "signed")
        .label("Asymmetry", "Asym")
      .floatField("toe", 0.25f, 0.f, 1.f, state::SecondaryInput)
        .label("Toe", "Toe")
      .floatField("shoulder", 0.50f, 0.f, 1.f, state::SecondaryInput)
        .label("Shoulder", "Shldr")
      .floatField("highlight_desat", 0.70f, 0.f, 1.f, state::SecondaryInput)
        .label("Highlight Desat", "HiDesat")
      .rgbField("highlight_tint", 1.00f, 0.22f, 0.62f, state::SecondaryInput)
        .label("Highlight Tint", "Hi Tint")
      .floatField("highlight_tint_amount", 0.0f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "Colours the blown-out cores that Highlight Desat just "
                  "bleached white. The swatch is what a fully clipped pixel "
                  "BECOMES, so what you pick is what you get — dim it for a "
                  "deeper, more saturated core, keep it hot for a tinted "
                  "white one.")
        .label("Highlight Tint Amount", "Tint Amt")
      .floatField("highlight_tint_pivot", 1.0f, 0.2f, 4.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "Where the tint starts biting, and how much of the image it "
                  "catches. 1.0 is exactly at clipping and the tint arrives "
                  "fully a stop above that; drop it to pull colour into "
                  "highlights that would have survived the tone map intact.")
        .label("Tint Pivot", "Pivot")
      .floatField("scanline", 0.12f, 0.f, 1.f, state::SecondaryInput)
        .label("Scanlines", "Scan")
      .intField("scanline_count", 240, 30, 720, state::SecondaryInput, 0, "lines")
        .label("Scanline Count", "Lines")
      .floatField("grain", 0.08f, 0.f, 1.f, state::SecondaryInput)
        .label("Grain", "Grain")
      .floatField("input_opacity", 1.0f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "How much of the incoming image survives under the stack.")
        .label("Input Opacity", "In Op")

      // ---------------- Debug ----------------
      .group("debug", "Debug")
      .boolField("debug_show_sdf", false, state::SecondaryInput,
                 "Banded distance field — check corner morphology.")
        .label("Show Distance Field", "SDF")
      .boolField("debug_show_planes", false, state::SecondaryInput,
                 "Flat per-plane keys, no glow or grade — check projection "
                 "and stacking order.")
        .label("Show Plane Keys", "Keys")

      // ---------------- Outputs ----------------
      // Declared min/max IS the modulation contract for these rails.
      .floatField("plane1_y", 0.f, -1.f, 1.f, state::PrimaryOutput, "signed",
                  0.f, nullptr, "Screen Y of plane 1's centre, cover-square.")
        .label("Plane 1 Y", "P1 Y")
      .floatField("plane2_y", 0.f, -1.f, 1.f, state::PrimaryOutput, "signed",
                  0.f, nullptr, "Screen Y of plane 2's centre, cover-square.")
        .label("Plane 2 Y", "P2 Y")
      .floatField("plane3_y", 0.f, -1.f, 1.f, state::PrimaryOutput, "signed",
                  0.f, nullptr, "Screen Y of plane 3's centre, cover-square.")
        .label("Plane 3 Y", "P3 Y")
      .floatField("plane1_half_h", 0.f, 0.f, 1.f, state::PrimaryOutput, "unsigned",
                  0.f, nullptr, "Half-height of plane 1's silhouette.")
        .label("Plane 1 Half Height", "P1 H")
      .floatField("plane2_half_h", 0.f, 0.f, 1.f, state::PrimaryOutput, "unsigned",
                  0.f, nullptr, "Half-height of plane 2's silhouette.")
        .label("Plane 2 Half Height", "P2 H")
      .floatField("plane3_half_h", 0.f, 0.f, 1.f, state::PrimaryOutput, "unsigned",
                  0.f, nullptr, "Half-height of plane 3's silhouette.")
        .label("Plane 3 Half Height", "P3 H")

      .textureField("tex_in",  state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)

      .capability(state::Capability::Generator)
      // Every envelope still lives outside this effect and the grain is
      // derived from absolute host time — but the GLINTS are particles with
      // lifetimes, and that is a real accumulator. A seek lands on a
      // different set of them in flight and is otherwise the same frame,
      // which is exactly what SeekableApproximate says. (With Drive at 0
      // there are none, and the effect is time-independent in practice.)
      .capability(state::Capability::SeekableApproximate)
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceMulti)
  );

  if (gpu::Device::backend() == gpu::Backend::None) return;

  state::registerShaderSPV("three_planes_render", RENDER_SPV, RENDER_SPV_SIZE);
  auto cs = gpu::Device::createShaderModuleByName("three_planes_render");
  if (!cs) return;

  s_pso = gpu::Device::createComputePSO(cs, "main", gpu::Bindings()
      .tex2d(0)
      .storageTex2d(1)
      .uniform(2));

  state::log("three_planes: module initialized");
}

void* create() {
  auto* s = new State();
  s->uniform_buf = gpu::Device::createBuffer(sizeof(Uniforms), gpu::BufferUsage::Uniform);
  return s;
}

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->uniform_buf.release();
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  projectPlanes(*s);
  if (!s_pso.valid() || !s->uniform_buf.valid()) return;
  s->initialized = true;
}

// The projection and both rails are viewport-free, so they belong here — no
// GPU readback, and downstream taps see this frame's values before render.
//
// The glints advance here too, and ONLY here: render() may be called without a
// tick (thumbnails, off-playhead previews) and stepping the particles from
// there would age them by a frame every time somebody looked at the card.
void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  projectPlanes(*s);
  publishRails(*s);

  three_planes_glints::Params gp;
  gp.drive = s->glimmer_drive;
  gp.density = s->glimmer_density;
  gp.speed = s->glimmer_speed;
  s->glint_core.tick(gp, (float)dt);
}

void on_resolume_param(void* self, long long param_id, double value) {
  (void)self; (void)param_id; (void)value;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int   l = len[i];

    if      (state::pathIs(p, l, "plane1_emission")) s->emission[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane2_emission")) s->emission[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane3_emission")) s->emission[2] = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane1_fill"))     s->fill[0] = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane2_fill"))     s->fill[1] = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane3_fill"))     s->fill[2] = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane1_color")) {
      auto v = state::patchVec3(i);
      s->color[0][0] = v.x; s->color[0][1] = v.y; s->color[0][2] = v.z;
    } else if (state::pathIs(p, l, "plane2_color")) {
      auto v = state::patchVec3(i);
      s->color[1][0] = v.x; s->color[1][1] = v.y; s->color[1][2] = v.z;
    } else if (state::pathIs(p, l, "plane3_color")) {
      auto v = state::patchVec3(i);
      s->color[2][0] = v.x; s->color[2][1] = v.y; s->color[2][2] = v.z;
    }
    else if (state::pathIs(p, l, "orbit_azimuth"))   s->orbit_azimuth = state::patchFloat(i);
    else if (state::pathIs(p, l, "elevation"))       s->elevation_deg = state::patchFloat(i);
    else if (state::pathIs(p, l, "zoom"))            s->zoom = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane_spacing"))   s->plane_spacing = state::patchFloat(i);
    else if (state::pathIs(p, l, "plane_size"))      s->plane_size = state::patchFloat(i);
    else if (state::pathIs(p, l, "corner_radius"))   s->corner_radius = state::patchFloat(i);

    else if (state::pathIs(p, l, "line_width"))      s->line_width = state::patchFloat(i);
    else if (state::pathIs(p, l, "line_gain"))       s->line_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "core_whiten"))     s->core_whiten = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_radius"))     s->halo_radius = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_gain"))       s->halo_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_falloff"))    s->halo_falloff = state::patchFloat(i);
    else if (state::pathIs(p, l, "halo_smooth"))     s->halo_smooth = state::patchFloat(i);
    else if (state::pathIs(p, l, "fill_gain"))       s->fill_gain = state::patchFloat(i);

    else if (state::pathIs(p, l, "glimmer_drive"))   s->glimmer_drive = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_density")) s->glimmer_density = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_speed"))   s->glimmer_speed = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_angle"))   s->glimmer_angle = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_width"))   s->glimmer_width = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_gain"))    s->glimmer_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_shadow"))  s->glimmer_shadow = state::patchFloat(i);

    else if (state::pathIs(p, l, "chroma_bleed"))    s->chroma_bleed = state::patchFloat(i);
    else if (state::pathIs(p, l, "warmth"))          s->warmth = state::patchFloat(i);
    else if (state::pathIs(p, l, "drive"))           s->drive = state::patchFloat(i);
    else if (state::pathIs(p, l, "exposure"))        s->exposure = state::patchFloat(i);
    else if (state::pathIs(p, l, "asymmetry"))       s->asymmetry = state::patchFloat(i);
    else if (state::pathIs(p, l, "toe"))             s->toe = state::patchFloat(i);
    else if (state::pathIs(p, l, "shoulder"))        s->shoulder = state::patchFloat(i);
    else if (state::pathIs(p, l, "highlight_desat")) s->highlight_desat = state::patchFloat(i);
    else if (state::pathIs(p, l, "highlight_tint")) {
      auto v = state::patchVec3(i);
      s->highlight_tint[0] = v.x; s->highlight_tint[1] = v.y; s->highlight_tint[2] = v.z;
    }
    else if (state::pathIs(p, l, "highlight_tint_amount")) s->highlight_tint_amount = state::patchFloat(i);
    else if (state::pathIs(p, l, "highlight_tint_pivot"))  s->highlight_tint_pivot = state::patchFloat(i);
    else if (state::pathIs(p, l, "scanline"))        s->scanline = state::patchFloat(i);
    else if (state::pathIs(p, l, "scanline_count"))  s->scanline_count = state::patchInt(i);
    else if (state::pathIs(p, l, "grain"))           s->grain = state::patchFloat(i);
    else if (state::pathIs(p, l, "input_opacity"))   s->input_opacity = state::patchFloat(i);

    else if (state::pathIs(p, l, "debug_show_sdf"))    s->debug_show_sdf = state::patchBool(i);
    else if (state::pathIs(p, l, "debug_show_planes")) s->debug_show_planes = state::patchBool(i);
  }
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;

  projectPlanes(*s);
  publishRails(*s);

  Uniforms u = {};
  for (int i = 0; i < PLANES; i++) {
    u.corners[i * 2 + 0][0] = s->corner_x[i][0];
    u.corners[i * 2 + 0][1] = s->corner_y[i][0];
    u.corners[i * 2 + 0][2] = s->corner_x[i][1];
    u.corners[i * 2 + 0][3] = s->corner_y[i][1];
    u.corners[i * 2 + 1][0] = s->corner_x[i][2];
    u.corners[i * 2 + 1][1] = s->corner_y[i][2];
    u.corners[i * 2 + 1][2] = s->corner_x[i][3];
    u.corners[i * 2 + 1][3] = s->corner_y[i][3];

    u.plane_color[i][0] = s->color[i][0];
    u.plane_color[i][1] = s->color[i][1];
    u.plane_color[i][2] = s->color[i][2];
    u.plane_color[i][3] = emissionDrive(s->emission[i]);
    u.fills[i] = s->fill[i];
  }

  // One pixel measured in cover-square units is 2 / max(W, H); widen it a
  // touch so the edge lands soft rather than stair-stepped.
  u.fills[3] = s->halo_smooth;

  const float px = 2.0f / float(vp_w > vp_h ? vp_w : vp_h);
  const auto  cs = fx::coverSquare(vp_w, vp_h);

  u.neon0[0] = lineHalfWidth(s->line_width);
  u.neon0[1] = s->line_gain;
  u.neon0[2] = s->core_whiten;
  u.neon0[3] = haloRadius(s->halo_radius);
  u.neon1[0] = s->halo_gain;
  u.neon1[1] = s->halo_falloff;
  u.neon1[2] = s->corner_radius;
  u.neon1[3] = px * 1.2f;

  u.misc[0] = s->fill_gain;
  u.misc[1] = s->chroma_bleed;
  u.misc[2] = s->input_opacity;
  u.misc[3] = s->debug_show_sdf ? 1.0f : (s->debug_show_planes ? 2.0f : 0.0f);

  u.view[0] = float(vp_w);
  u.view[1] = float(vp_h);
  u.view[2] = cs.ax;
  u.view[3] = cs.ay;

  // Travel direction, measured CCW from +x the way an angle normally is —
  // hence the negated sine, because cover-square y grows DOWNWARD. Each glint
  // sits square across this.
  const float ga = s->glimmer_angle * (kPi / 180.0f);
  const float dx = std::cos(ga), dy = -std::sin(ga);
  u.glim0[0] = dx;
  u.glim0[1] = dy;

  // How far the frame reaches along that axis: the corner that projects
  // furthest onto it. Deriving anything here from the VIEWPORT rather than
  // from a fixed number is what makes Speed and Width mean the same thing
  // whatever shape the output is and whichever way the glints are running.
  const float span = std::fabs(dx) * (0.5f / cs.ax) + std::fabs(dy) * (0.5f / cs.ay);

  // ...but the frame is NOT what a glint travels across. It multiplies
  // emission, so out where there is no geometry it is multiplying nothing, and
  // every unit of travel spent there is dead time between throwing a glint and
  // seeing it. On a default stack that dead run is most of the way in from
  // each corner — and at the idle speed it is seconds of it.
  //
  // So the trip is bounded by the LIT extent instead: the furthest any plane's
  // corner projects onto the travel axis, plus the halo and line it carries
  // out past that. A glint is then doing something almost from the moment it
  // is born.
  float reach = 0.0f;
  for (int i = 0; i < PLANES; i++) {
    for (int k = 0; k < 4; k++) {
      const float a = std::fabs(s->corner_x[i][k] * dx + s->corner_y[i][k] * dy);
      if (a > reach) reach = a;
    }
  }
  reach += haloRadius(s->halo_radius) + lineHalfWidth(s->line_width);
  // Never further than the picture: an enormous zoom would otherwise send
  // glints off on a tour of geometry nobody can see. And never zero, so a
  // collapsed camera cannot divide the travel down to nothing.
  if (reach > span) reach = span;
  if (reach < 0.05f) reach = 0.05f;

  // The glint scales with what it is crossing, not with the frame — which is
  // what keeps Width meaning "a fraction of the distance it travels".
  const float hw = s->glimmer_width * reach;
  // Born and buried outside that extent, so a glint fades in and its wake
  // fades out rather than either popping. Sized for the WIDEST glint the
  // birth spread can draw, because the mapping from `pos` to the screen has to
  // be the same for every glint in flight or two of them could cross.
  const float hw_max = hw * three_planes_glints::kMaxWidthFactor;
  const float from = -(reach + kGlintSkirt * hw_max);
  const float to = reach + kGlintWakeReach * hw_max;

  for (int i = 0; i < three_planes_glints::kMaxLive; i++) {
    const auto& g = s->glint_core.glints[i];
    // A dead slot is a zero-gain, zero-shade glint of unit width: it costs the
    // shader two exponentials and contributes exactly nothing, which is
    // cheaper than a branch and keeps the loop fully unrolled.
    u.glints[i][0] = g.live ? from + g.pos * (to - from) : 0.0f;
    u.glints[i][1] = g.live ? hw * g.width : 1.0f;
    u.glints[i][2] = g.live ? s->glimmer_gain * g.gain : 0.0f;
    u.glints[i][3] = g.live ? s->glimmer_shadow * g.shade : 0.0f;
  }

  u.grade[0]  = s->exposure;
  u.grade[1]  = s->warmth;
  u.grade[2]  = s->drive;
  u.grade[3]  = s->asymmetry;
  u.grade[4]  = s->toe;
  u.grade[5]  = s->shoulder;
  u.grade[6]  = s->highlight_desat;
  u.grade[7]  = s->scanline;
  u.grade[8]  = float(s->scanline_count);
  u.grade[9]  = s->grain;
  // Derived from ABSOLUTE host time, not an accumulator, so the effect stays
  // TimeIndependent: a scrub lands on the right frame with the right grain.
  u.grade[10] = float(std::fmod(host::time() * 997.0, 4096.0));
  u.grade[11] = s->highlight_tint_pivot;
  u.grade[12] = s->highlight_tint[0];
  u.grade[13] = s->highlight_tint[1];
  u.grade[14] = s->highlight_tint[2];
  u.grade[15] = s->highlight_tint_amount;

  s->uniform_buf.writeOne(u);

  auto cp = gpu::ComputePass::begin();
  cp.setPSO(s_pso);
  cp.setTexture(in,  0, 0);
  cp.setTexture(out, 1, 1);
  cp.setBuffer(s->uniform_buf, 2);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace three_planes
