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
#include <sketch/three_planes_strobe.h>
#include "three_planes_shaders.h"

#include <cmath>
#include <cstdint>

namespace three_planes {

static constexpr int PLANES = 3;
// What a throw does with the stack. See the Release group help.
static constexpr int kModeGrow   = 0;
static constexpr int kModeStrobe = 1;
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
  // The release: the stack thrown. Both modes draw through these same rows —
  // Grow expands them and opens the halo out, Strobe leaves them exactly on
  // the quads and gates them one floor at a time.
  float ghosts[6][4];       // rows 14-19: ghost i -> rows 2i, 2i+1, like `corners`
  float rel[4];             // row 20:    ghost halo radius, falloff, -, -
  float ring_gain[4];       // row 21:    per-ghost gain: the throw, damped and gated
  float glim0[4];           // row 22:    travel dir x, dir y, -, -
  // One row per glint IN FLIGHT: where it is on the travel axis (cover-square),
  // its half-width there, and the two look values it was born with. A dead slot
  // is zero gain and zero shade, so the shader needs no count and no branch.
  float glints[8][4];       // rows 23-30: axis, half-width, gain, shade
  float mask[4];            // row 31:    strength (0 = nothing wired), halo cut, -, -
  float grade[16];          // rows 32-35: VcrGrade
};
static_assert(sizeof(Uniforms) == 576, "Uniforms layout mismatch with render.hlsl");
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

  // --- Release ---
  // The throw, from the rig: 1 the instant a mute spends the latched charge,
  // falling to 0 across the ring-out. Everything here is a pure function of
  // it, which is what keeps the rings stateless.
  float release        = 0.0f;
  float release_expand = 1.80f;   // how far the rings fly, as a fraction of the stack
  float release_gain   = 2.20f;
  float release_blur   = 10.0f;   // how far the halo opens out as they go
  float release_contrast = 0.80f; // how hard a lit plane holds its own ring down

  // Which throw. Grow flings the stack outward; Strobe keeps it exactly where
  // it is and flams the floors one at a time on a roll that putters out. The
  // two draw through the SAME three ghost quads — see render() — so the mode
  // costs nothing but the numbers fed to them.
  int   release_mode  = kModeGrow;
  float strobe_rate   = 22.0f;    // steps per second
  float strobe_duty   = 0.55f;    // on-window per step, at full release
  float strobe_gain   = 1.10f;
  float strobe_glow   = 0.28f;    // halo radius, as a fraction of the live one
  float strobe_grace  = 0.35f;
  three_planes_strobe::Core strobe;

  // One frame of nothing between the throw and the rings appearing. Counted
  // in tick(), because render() can be called without one.
  float prev_release = 0.0f;
  int ring_delay = 0;

  // --- Glimmer ---
  // The rhythm still comes from outside — `glimmer_drive` is the rig's Sweep
  // knob — but the glints themselves are PARTICLES with lifetimes, so unlike
  // everything else in this effect they are an accumulator. See
  // <sketch/three_planes_glints.h>; it is why the effect is only
  // SeekableApproximate rather than TimeIndependent.
  three_planes_glints::Core glint_core;
  float glimmer_sweep   = 0.5f;    // the knob itself, wired from the rig
  float glimmer_band    = 0.45f;   // launch band, fraction of each half of the throw
  float glimmer_ratio   = 1.0f;    // crossings per knob range
  float glimmer_chaos   = 4.0f;    // small extra glints per second, when sweeping fast
  float glimmer_angle   = 45.0f;   // degrees, travel direction, CCW from +x
  float glimmer_width   = 0.07f;   // glint half-width, fraction of one crossing
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
  float mask_strength   = 1.0f;
  float mask_halo       = 0.6f;

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

static inline float clamp01f(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

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

// Strobe's halo, as a fraction of the live one. Linear, and never quite zero:
// the profile peaks at 1 whatever its radius, so at 0 you would still get a
// line — just an aliased one-pixel line with nothing around it, which is a
// worse picture than the hairline this floors it at.
static inline float strobeGlow(float t) {
  float k = t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t);
  return 0.02f + 0.98f * k;
}

// Strobe's per-floor duty scale: exactly Grow's local-contrast damping, spent
// on the LENGTH of a hit instead of on its brightness. A floor that is already
// lit underneath keeps its flam at full strength and gets less of it, and once
// its window falls under a frame the flam simply stops landing there.
static inline float strobeWeight(const State& s, int i) {
  const float lit = s.emission[i] < 0.0f ? 0.0f
                  : (s.emission[i] > 1.0f ? 1.0f : s.emission[i]);
  const float w = 1.0f - s.release_contrast * lit;
  return w < 0.0f ? 0.0f : w;
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

// The two throw modes have disjoint controls and nothing to say about each
// other's, so a card only ever shows the one it is in.
static void applyModeVisibility(const State* s) {
  const bool strobe = s->release_mode == kModeStrobe;
  state::setFieldHidden("release_expand", strobe);
  state::setFieldHidden("release_gain",   strobe);
  state::setFieldHidden("release_blur",   strobe);
  state::setFieldHidden("strobe_rate",   !strobe);
  state::setFieldHidden("strobe_duty",   !strobe);
  state::setFieldHidden("strobe_gain",   !strobe);
  state::setFieldHidden("strobe_glow",   !strobe);
  state::setFieldHidden("strobe_grace",  !strobe);
  // `release_contrast` belongs to both: it is the rule about two bright things
  // in one place, and Strobe puts them there by construction.
}

// Fires once after init and the initial state replay, so a restored card never
// flashes the other mode's fields.
static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) applyModeVisibility(s);
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
          "Plane 1 is the ground floor, plane 3 the top.\n\n"
          "**Emission runs past 1.** Fully lit is 1; the rest of the range is "
          "overdrive, where the cores blow out and the halo goes with them. "
          "That headroom is there so a level can OVERSHOOT its own base — it "
          "is what Three Planes Rig's *Bounce* spends on the way back in — "
          "and it is yours to dial by hand too.")
      .floatField("plane1_emission", 0.85f, 0.f, 1.5f, state::PrimaryInput)
        .label("Plane 1 Emission", "P1 Emit")
      .floatField("plane1_fill", 0.0f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Plane 1 Fill", "P1 Fill")
      .rgbField("plane1_color", 1.00f, 0.22f, 0.62f, state::PrimaryInput)
        .label("Plane 1 Colour", "P1 Col")
      .floatField("plane2_emission", 0.85f, 0.f, 1.5f, state::PrimaryInput)
        .label("Plane 2 Emission", "P2 Emit")
      .floatField("plane2_fill", 0.0f, -1.f, 1.f, state::PrimaryInput, "signed")
        .label("Plane 2 Fill", "P2 Fill")
      .rgbField("plane2_color", 0.30f, 0.85f, 1.00f, state::PrimaryInput)
        .label("Plane 2 Colour", "P2 Col")
      .floatField("plane3_emission", 0.85f, 0.f, 1.5f, state::PrimaryInput)
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

      // ---------------- Release ----------------
      .group("release", "Release")
        .groupHelp(
          "The throw. Wire *Release* from **Three Planes Rig** and reaching "
          "either end of the sweep stops being merely a blackout: the stack is "
          "flung outward as three expanding rings that ring down on their own "
          "clock, over the muted picture.\n\n"
          "They are the SAME three quads, thrown — the outline and nothing "
          "else, since a ring has no inside. As they fly they open out and go "
          "soft: bright and tight at the throw, wide and dull by the end. That "
          "is deliberately what a filter closing sounds like, and it is why "
          "the tail reads as a special state rather than as the picture merely "
          "being dimmer.\n\n"
          "The rig gives the tail a straight-line fall on purpose, which makes "
          "this a constant outward speed — a shockwave with an end, rather "
          "than something that leaps out and then creeps.\n\n"
          "Nothing about where the knob goes next can cancel a throw, so "
          "sweeping straight back relights the tower over a tail still "
          "running. That overlap is the move — and *Local Contrast* is what "
          "keeps it legible, holding a ring down while it is still sitting on "
          "the plane that threw it.\n\n"
          "The rings appear one frame AFTER the throw, on purpose. The frame "
          "that fires one is already black, so the picture lands on nothing "
          "before it lands on the release, and the hit reads harder for it.\n\n"
          "**Strobe** is the same throw pointed the other way. Nothing flies: "
          "the stack comes straight back exactly where it was, as bare "
          "wireframe with barely any glow, and then breaks up — the floors "
          "flam one at a time on a fast roll whose hits get SHORTER as the "
          "tail runs down, until they start missing frames outright and it "
          "sputters out.\n\n"
          "Nothing in Strobe ever dims. Every hit lands at full strength or "
          "does not land, and everything that would turn one down — the decay, "
          "the local contrast — takes its window away instead. A strobe that "
          "fades reads as a light going out; one that thins reads as a thing "
          "running down.\n\n"
          "Grow is energy leaving the frame; Strobe is energy rattling around "
          "inside it, and they cut against each other well enough to be worth "
          "switching between on the fly.")
      .floatField("release", 0.0f, 0.f, 1.f, state::PrimaryInput,
                  "unsigned", 0.f, nullptr,
                  "The throw, ringing out. At 0 there is nothing to see, so an "
                  "unwired card is exactly as it was.")
        .label("Release", "Rel")
      .selectField("release_mode", kModeGrow, state::PrimaryInput,
                   {{"Grow", kModeGrow}, {"Strobe", kModeStrobe}}, false,
                   "What a throw does with the stack. **Grow** flings it "
                   "outward as three rings that open up and go soft. "
                   "**Strobe** leaves it where it is and flams the floors one "
                   "at a time until the roll putters out. Each mode shows only "
                   "its own controls; *Local Contrast* belongs to both.")
        .label("Throw Mode", "Mode")
      .floatField("release_expand", 1.80f, 0.f, 4.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How far the rings fly, as a fraction of the stack\'s own "
                  "size. They start exactly on the quads that threw them.")
        .label("Throw Distance", "Throw")
      .floatField("release_gain", 2.20f, 0.f, 6.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How bright the rings are at the moment of the throw. They "
                  "dim as they open out, so this is the punch, not the tail.")
        .label("Throw Gain", "RelGain")
      .floatField("release_blur", 10.0f, 1.f, 30.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "How far the rings open out as they fly — the filter "
                  "closing. 1 keeps them as tight as the tubes they came off; "
                  "high values leave a wide, dull smear behind.")
        .label("Throw Blur", "RelBlur")

      // Strobe. Rate stays put through the whole tail on purpose — the decay
      // is the WINDOW closing, not the roll slowing down, because a roll that
      // slows reads as a machine winding down and a window that closes reads
      // as one being switched off.
      .floatField("strobe_rate", 22.0f, 4.f, 60.f, state::PrimaryInput,
                  nullptr, 0.f, "steps/s",
                  "How fast the roll goes. It does not change as the tail runs "
                  "down; only the hits get shorter.")
        .label("Roll Rate", "Rate")
      .floatField("strobe_duty", 0.55f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How much of each step a floor is lit for, at the moment of "
                  "the throw. This is the thing that putters out: the release "
                  "scales it, so by the end the window is shorter than a frame "
                  "and the hits start missing frames altogether. High values "
                  "run the floors into each other and it reads as a wave; low "
                  "ones are already sparse at the top of the tail.")
        .label("Duty", "Duty")
      .floatField("strobe_gain", 1.10f, 0.f, 4.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How bright a hit is — and every hit is this bright, "
                  "including the last one. The decay is in the timing.")
        .label("Roll Gain", "RollG")
      .floatField("strobe_glow", 0.28f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How much halo the wireframe carries, as a fraction of the "
                  "live one. Near 0 it is a bare tube with a breath around it, "
                  "which is the whole point of the mode: the throw looks like "
                  "the drawing under the picture rather than like the picture "
                  "again.")
        .label("Wire Glow", "WireG")
      .floatField("strobe_grace", 0.35f, 0.f, 1.f, state::SecondaryInput,
                  nullptr, 0.f, nullptr,
                  "The flam. The next floor speaks quietly just before each "
                  "step changes, then lands — two strokes where a roll would "
                  "have one, as a fraction of a step. At 0 it is a plain "
                  "metronome up and down the tower; near 1 the two strokes run "
                  "together and the roll reads as a wave instead.")
        .label("Flam", "Flam")

      .floatField("release_contrast", 0.80f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How hard a lit plane holds its own ghost down while the "
                  "ghost is still on top of it. Sweeping straight back after a "
                  "throw relights the tower underneath a ring that has barely "
                  "left it, and two bright things in the same place read as "
                  "one; this keeps them apart. In **Grow** it fades out as the "
                  "ring flies clear, so a ring well away from the stack is at "
                  "full strength whatever the tower is doing.\n\n"
                  "**Strobe** spends it on the WINDOW instead of on the "
                  "brightness — a lit floor gets a shorter flam, not a dimmer "
                  "one, and once its window drops under a frame the flam stops "
                  "landing on that floor at all. Nothing in that mode ever "
                  "turns a hit down when it could drop it.")
        .label("Local Contrast", "Contrast")

      // ---------------- Glimmer ----------------
      .group("glimmer", "Glimmer")
        .groupHelp(
          "Slanted glints that travel across the stack — the glare off metal "
          "in an old cel-animated show.\n\n"
          "**The glint is the gesture.** Wire *Glint Sweep* from the rig\'s "
          "*Sweep Out* and the rule is: move the knob at a steady speed across "
          "its whole range, and ONE glint crosses the stack at exactly that "
          "rate. The launch is the moment the knob enters the middle band — "
          "which happens once per traverse, and can only happen while you are "
          "moving, so there is always a real speed for the new glint to "
          "take.\n\n"
          "Which WAY you move it is thrown away. Reverse mid-gesture and the "
          "glints already out there carry on exactly as they were: they are "
          "objects in flight, not a readout. Nothing about the knob reaches a "
          "live glint again except its speed — and that is shared by all of "
          "them, because at their own speeds two would eventually cross, and "
          "the moment they overlap they stop being two things.\n\n"
          "Sweep hard and *Chaos* starts adding small ones underneath, at "
          "random intervals. They are dimmer and narrower on purpose, so the "
          "gesture stays legible through them.\n\n"
          "Glints multiply the **emission** of everything the card draws — the "
          "planes and the release ghosts alike — rather than the finished "
          "picture. That is the whole trick: emission scales the line core, "
          "the halo and the fill together, so one crossing a tube brightens "
          "the glow around it too and reads as light IN the tube rather than a "
          "highlight pasted over it. They are also born just outside the stack "
          "and retired just past it, rather than crossing the whole frame, so "
          "one starts working the moment it is thrown.\n\n"
          "*Shadow* is what sells it — a dark wake trailing each glint, so the "
          "stack gains contrast rather than just getting brighter.\n\n"
          "A throw holds whatever is in the air at full strength while it "
          "rings out, in both modes — letting go of the knob to reach a mute "
          "is exactly the gesture that fires one, so a glint being thrown is "
          "never a glint running down. What differs is where they go: **Grow** "
          "slings them off with everything else, and **Strobe**, which keeps "
          "everything inside the frame, lets them hang about and drift over "
          "the flam instead.")
      .floatField("glimmer_sweep", 0.5f, 0.f, 1.f, state::PrimaryInput,
                  "unsigned", 0.f, nullptr,
                  "The sweep knob itself — wire it from Three Planes Rig's "
                  "*Sweep Out*. Its MOTION is the whole input: a glint "
                  "launches every time it enters the middle band, travelling "
                  "at the speed you moved.")
        .label("Glint Sweep", "Sweep")
      .floatField("glimmer_ratio", 1.0f, 0.f, 4.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "Crossings of the picture per full range of the knob. At 1 "
                  "a sweep across the whole knob is one glint across the whole "
                  "stack, in the same time — turn it up and the glint outruns "
                  "your hand.")
        .label("Glint Ratio", "Ratio")
      .floatField("glimmer_band", 0.45f, 0.02f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How wide the middle band is, as a fraction of each half of "
                  "the throw. Entering it is what launches a glint, so this is "
                  "where in the sweep it happens. Matching the rig's Deadzone "
                  "puts the launch exactly where the tower is at full "
                  "brightness.")
        .label("Launch Band", "Band")
      .floatField("glimmer_chaos", 4.0f, 0.f, 16.f, state::PrimaryInput,
                  nullptr, 0.f, "/s",
                  "Small extra glints per second, once the sweep is brisk. "
                  "They are dimmer and narrower than the launched one on "
                  "purpose — the gesture stays legible and the chaos sits "
                  "under it. 0 leaves one clean glint per pass.")
        .label("Chaos", "Chaos")
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

      // ---------------- Mask ----------------
      .group("mask", "Mask")
      .groupHelp(
        "A second image — text, a logo, any shape — wired into *Mask In* and "
        "laid over the stack in SCREEN space, so what you see in that input is "
        "where it lands.\n\n"
        "What it covers is CUT AWAY, exactly the way a plane at Fill -1 cuts: "
        "a hole through the picture rather than a sticker on it. That is why "
        "there is no colour here — a mask has a shape, not a look.\n\n"
        "Its weight is the mask's **alpha times its luma**, and it wants both. "
        "A shape that is present but black is not a mask, and neither is a "
        "bright shape that is not there — so an ordinary rendered logo works "
        "as it comes, with no separate matte to author and keep in step.\n\n"
        "*Halo Cut* is the one place the hole is not clean. A tube behind a "
        "letter still throws light around the letter's edges, so by default "
        "the mask takes the neon's body outright and only some of its glow. "
        "Turn it up for a hard stencil; turn it down and the shape sits deep "
        "in the light instead of on the glass.")
      .textureField("mask_in", state::SecondaryInput)
        .label("Mask In", "Mask")
      .floatField("mask_strength", 1.0f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How hard the mask cuts. 0 ignores it entirely.")
        .label("Mask Amount", "Amt")
      .floatField("mask_halo", 0.6f, 0.f, 1.f, state::PrimaryInput,
                  nullptr, 0.f, nullptr,
                  "How much of the HALO the mask takes with it. 1 cuts the "
                  "glow as hard as the tube; 0 lets all of it bleed over the "
                  "shape.")
        .label("Halo Cut", "Halo")

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
      .uniform(2)
      .tex2d(3));

  state::setOnStateReady(&on_state_ready);
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

  // THE BEAT BEFORE THE HIT. A throw fires on the frame the tower mutes, so
  // that frame is already black — and holding the rings back for exactly one
  // more makes the picture land on nothing before it lands on the release.
  // A hit reads harder for the silence in front of it.
  if (s->release > s->prev_release + 1e-4f) s->ring_delay = 1;
  else if (s->ring_delay > 0) --s->ring_delay;
  s->prev_release = s->release;

  three_planes_glints::Params gp;
  gp.sweep = s->glimmer_sweep;
  gp.band = s->glimmer_band;
  gp.ratio = s->glimmer_ratio;
  gp.chaos = s->glimmer_chaos;
  gp.fling = s->release;
  // A throw holds the glints up in both modes, but only Grow carries them off
  // with it. Strobe keeps everything inside the frame — slinging the glints
  // out of the picture is the one thing in it that would go the other way — so
  // there they are held and left to drift instead.
  gp.sling = s->release_mode == kModeStrobe ? 0.0f : 1.0f;
  // The margins, in CROSSINGS — the units `pos` is in. A glint is born `lead`
  // before the lit picture starts and retired `trail` after it ends, sized by
  // the widest glint the birth spread can draw so every one of them maps from
  // `pos` to the screen the same way (see render()). The projection cancels:
  // `glimmer_width` is already a fraction of one crossing, so a half-width is
  // half of it whatever the stack's size on screen turns out to be.
  const float hw_max = s->glimmer_width * three_planes_glints::kMaxWidthFactor;
  gp.lead = kGlintSkirt * hw_max * 0.5f;
  gp.trail = kGlintWakeReach * hw_max * 0.5f;
  s->glint_core.tick(gp, (float)dt);

  // THE ROLL, if this is a Strobe throw. Its clock does not start until the
  // picture does — the held frame above is silence on purpose, and letting the
  // roll run through it would eat most of the arrival it is there to set up.
  three_planes_strobe::Params sp;
  sp.release = s->release;
  sp.rate    = s->strobe_rate;
  sp.duty    = s->strobe_duty;
  sp.grace   = s->strobe_grace;
  // Local contrast, as a WINDOW and not as a dimmer. See render() for what
  // Grow does with the same number, and the header for why Strobe refuses to
  // turn a hit down when it could drop it instead.
  for (int i = 0; i < PLANES; i++) sp.weight[i] = strobeWeight(*s, i);
  s->strobe.tick(sp, s->ring_delay > 0 ? 0.0f : (float)dt);
}

void on_resolume_param(void* self, long long param_id, double value) {
  (void)self; (void)param_id; (void)value;
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;

  bool vis_dirty = false;
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

    else if (state::pathIs(p, l, "release"))         s->release = state::patchFloat(i);
    else if (state::pathIs(p, l, "release_expand"))  s->release_expand = state::patchFloat(i);
    else if (state::pathIs(p, l, "release_gain"))    s->release_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "release_blur"))    s->release_blur = state::patchFloat(i);
    else if (state::pathIs(p, l, "release_contrast")) s->release_contrast = state::patchFloat(i);
    else if (state::pathIs(p, l, "release_mode")) {
      s->release_mode = state::patchInt(i);
      vis_dirty = true;
    }
    else if (state::pathIs(p, l, "strobe_rate"))    s->strobe_rate = state::patchFloat(i);
    else if (state::pathIs(p, l, "strobe_duty"))    s->strobe_duty = state::patchFloat(i);
    else if (state::pathIs(p, l, "strobe_gain"))    s->strobe_gain = state::patchFloat(i);
    else if (state::pathIs(p, l, "strobe_glow"))    s->strobe_glow = state::patchFloat(i);
    else if (state::pathIs(p, l, "strobe_grace"))   s->strobe_grace = state::patchFloat(i);

    else if (state::pathIs(p, l, "glimmer_sweep"))   s->glimmer_sweep = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_band"))    s->glimmer_band = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_ratio"))   s->glimmer_ratio = state::patchFloat(i);
    else if (state::pathIs(p, l, "glimmer_chaos"))   s->glimmer_chaos = state::patchFloat(i);
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
    else if (state::pathIs(p, l, "mask_strength"))  s->mask_strength = state::patchFloat(i);
    else if (state::pathIs(p, l, "mask_halo"))      s->mask_halo = state::patchFloat(i);

    else if (state::pathIs(p, l, "debug_show_sdf"))    s->debug_show_sdf = state::patchBool(i);
    else if (state::pathIs(p, l, "debug_show_planes")) s->debug_show_planes = state::patchBool(i);
  }
  if (vis_dirty) applyModeVisibility(s);
}

void render(void* self, int vp_w, int vp_h) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized || vp_w <= 0 || vp_h <= 0) return;

  auto in  = gpu::Device::textureForField("tex_in");
  auto out = gpu::Device::textureForField("tex_out");
  if (!in.valid() || !out.valid()) return;
  // Nothing wired: bind the input in its place and hand the shader a strength
  // of 0. The sample still happens and reads nothing into the picture, which
  // is cheaper than a branch and leaves the binding table the same shape every
  // frame.
  auto mask = gpu::Device::textureForField("mask_in");
  const bool has_mask = mask.valid();
  if (!has_mask) mask = in;

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

  // THE RELEASE RINGS. The same three quads, thrown outward from the stack's
  // centre — which is the origin, because the middle plane's centre is where
  // the camera orbits — so the floors spread apart as they fly rather than
  // just growing. Everything is a pure function of `release`: at 1 a ring sits
  // exactly on the quad that threw it, and by 0 it has flown its full distance
  // and gone out. That is what keeps them stateless despite reading as
  // objects with a life.
  const float rel = s->release < 0.0f ? 0.0f : (s->release > 1.0f ? 1.0f : s->release);
  const float flown = 1.0f - rel;                       // 0 at the throw, 1 spent
  const bool strobe = s->release_mode == kModeStrobe;
  // STROBE throws the stack nowhere. The ghosts sit exactly on the quads that
  // made them and stay there, which is what makes them read as the bars coming
  // BACK — bare wireframe over a muted picture — rather than as light leaving.
  // Everything after this point is the same code for both modes with different
  // numbers in it, which is the whole reason there is only one ghost path.
  const float grow = strobe ? 1.0f : 1.0f + s->release_expand * flown;
  for (int i = 0; i < PLANES; i++) {
    u.ghosts[i * 2 + 0][0] = s->corner_x[i][0] * grow;
    u.ghosts[i * 2 + 0][1] = s->corner_y[i][0] * grow;
    u.ghosts[i * 2 + 0][2] = s->corner_x[i][1] * grow;
    u.ghosts[i * 2 + 0][3] = s->corner_y[i][1] * grow;
    u.ghosts[i * 2 + 1][0] = s->corner_x[i][2] * grow;
    u.ghosts[i * 2 + 1][1] = s->corner_y[i][2] * grow;
    u.ghosts[i * 2 + 1][2] = s->corner_x[i][3] * grow;
    u.ghosts[i * 2 + 1][3] = s->corner_y[i][3] * grow;
  }
  // Bright and tight at the throw, wide and dull by the end: the core goes
  // first and only the glow is left, which is a low-pass closing drawn in
  // space rather than heard.
  //
  // The gain is divided by how far it has opened, and that is not a taste
  // decision — the halo profile peaks at 1 whatever its radius, so widening it
  // alone spreads the SAME peak over more picture and the ring gets BRIGHTER
  // as it dissipates. Dividing conserves roughly the light it was thrown with,
  // which is the difference between a ring going out and a ring blooming.
  //
  // Strobe opts out of all of that: it is a fixed look, not a flight. Its halo
  // is a fraction of the live one — barely there, so what is left is the tube
  // and a breath around it — and its gain is exactly what it says, since
  // nothing is dissipating.
  const float opened = strobe ? 1.0f : 1.0f + (s->release_blur - 1.0f) * flown;
  const float ring_scale = strobe ? strobeGlow(s->strobe_glow) : opened;
  u.rel[0] = haloRadius(s->halo_radius) * ring_scale;
  u.rel[1] = s->halo_falloff;

  // FAKED LOCAL CONTRAST. Sweep straight back after a throw and the tower
  // relights UNDERNEATH a ring that has barely left it — two bright things in
  // the same place, which reads as one bright thing and loses the ring. So a
  // lit plane holds its own ring down, and only while the ring is still on top
  // of it: the damping is the plane's brightness times how close the ring
  // still is, so by the time it has flown clear it is back to full strength
  // whatever the tower is doing. Per ring, because the floors light
  // separately — the cap can be blazing while the ground floor is dark.
  const float gate = s->ring_delay > 0 ? 0.0f : 1.0f;
  for (int i = 0; i < PLANES; i++) {
    if (strobe) {
      // Strobe never touches a brightness. Its decay is the window closing and
      // its local contrast is the window closing — both already spent on the
      // roll's timing back in tick(), where `strobeWeight` went in — so a hit
      // that happens at all happens at full strength. See the header: a
      // dimming strobe reads as a light going out, a thinning one reads as a
      // thing running down, and only the second is the move.
      u.ring_gain[i] = s->strobe_gain * s->strobe.gain[i] * gate;
      continue;
    }
    // Grow does fade, because brightness IS its decay: the ring opens out and
    // goes dull as it flies, and the damping rides on how close it still is.
    const float lit = s->emission[i] < 0.0f ? 0.0f : (s->emission[i] > 1.0f ? 1.0f : s->emission[i]);
    float damp = 1.0f - s->release_contrast * lit * rel;
    if (damp < 0.0f) damp = 0.0f;
    u.ring_gain[i] = s->release_gain * rel / opened * damp * gate;
  }

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

  u.mask[0] = has_mask ? clamp01f(s->mask_strength) : 0.0f;
  u.mask[1] = clamp01f(s->mask_halo);
  u.mask[2] = 0.0f;
  u.mask[3] = 0.0f;

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

  // A crossing is the whole lit extent, so `pos` 0..1 spans -reach..+reach and
  // a glint's half-width is half of `glimmer_width` of that. Which is what
  // makes the header's invariant exact: `pos` advances at the knob's own speed
  // in crossings per second, and one crossing is one traverse of the picture.
  const float hw = s->glimmer_width * reach;

  for (int i = 0; i < three_planes_glints::kMaxLive; i++) {
    const auto& g = s->glint_core.glints[i];
    // A dead slot is a zero-gain, zero-shade glint of unit width: it costs the
    // shader two exponentials and contributes exactly nothing, which is
    // cheaper than a branch and keeps the loop fully unrolled.
    u.glints[i][0] = g.live ? -reach + g.pos * 2.0f * reach : 0.0f;
    // drawWidth/drawGain/drawShade, not the raw birth values: a glint that has
    // outlived its gesture is puttering out, and that is where it shows.
    u.glints[i][1] = g.live ? hw * g.drawWidth() : 1.0f;
    u.glints[i][2] = g.live ? s->glimmer_gain * g.drawGain() : 0.0f;
    u.glints[i][3] = g.live ? s->glimmer_shadow * g.drawShade() : 0.0f;
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
  cp.setTexture(mask, 3, 0);
  cp.dispatch((vp_w + 7) / 8, (vp_h + 7) / 8);
  cp.end();

  gpu::Device::submit();
}

} // namespace three_planes
