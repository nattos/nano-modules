/*
 * mod.source.spectral_lfo — spectral-morph LFO generator.
 *
 * Productionized from the nano-lfo Serum-shape explorer. A baked atlas of
 * ~2178 LFO shapes (Serum control points) is laid out per metric by a t-SNE
 * embedding; a 2D position (morph_x, morph_y) selects the surrounding Delaunay
 * triangle and the 3 shapes are spectrally morphed (FFT → barycentric blend →
 * IFFT → geometric straighten) into one LFO curve. A phase accumulator advances
 * at `rate` and samples the curve, publishing a scalar `output` in [0,1].
 *
 * Pure data module — no GPU, no texture I/O (like env_lfo). The atlas itself is
 * CPU-only constant data in spectral_lfo_atlas.h.
 *
 * The post-processing toggles (Lanczos sigma / phase-coherence / geometric
 * straightening / wobble cleanup / de-ringing) are locked to the web app's
 * defaults: sigma=0, phaseCoherence=1, geoStraighten=1, the rest off. Only the
 * `metric` and `interpolation` controls are exposed.
 */

#include <host.h>
#include <val.h>
#include <cmath>
#include <cstdint>
#include <algorithm>

#include "spectral_curve.h"   // shared atlas lookup + spectral-morph curve build

namespace spectral_lfo {

// ─── rate → Hz mapping (perceptual exponential; accumulator-driven) ────
// rate ∈ [0,1] → Hz on an exponential curve; rate≈0 freezes the LFO.
static const double HZ_MIN = 0.02;
static const double HZ_MAX = 8.0;
static inline double rateToHz(float rate) {
  if (rate <= 1e-4f) return 0.0;
  return HZ_MIN * std::pow(HZ_MAX / HZ_MIN, (double)rate);
}

// ─── autopilot epicycle (sweeps the t-SNE plane) ───────────────────────
static const float kApA   = 0.32f;
static const float kApB   = 0.18f;
static const float kApW2  = 1.6180339f;
static const float kApPhi = 1.0f;
static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static inline void orbit_xy(float orbit, float& ox, float& oy) {
  const float a1 = orbit;
  const float a2 = orbit * kApW2 + kApPhi;
  ox = clampf(0.5f + kApA * std::cos(a1) + kApB * std::cos(a2), 0.02f, 0.98f);
  oy = clampf(0.5f + kApA * std::sin(a1) + kApB * std::sin(a2), 0.02f, 0.98f);
}

// ─── satellites (three offset taps forming a triangle around the center) ─
// spread ∈ [0,1] → orbit radius in t-SNE space (quadratic for finer low-end
// control: 0.5 → 0.25); rotation ∈ [0,1] → full turn.
// NOTE: the web inspector mirrors this layout (spectral-lfo-inspector.ts).
static const float kSatRadiusMax = 0.45f;
static const float kTwoPi        = 6.2831853071795864f;
static const float kThirdTurn    = 2.0943951023931953f;  // 2π/3
static inline void satellite_xy(float cx, float cy, float spread, float rotation,
                                int k, float& sx, float& sy) {
  const float radius = spread * spread * kSatRadiusMax;
  const float ang = rotation * kTwoPi + (float)k * kThirdTurn;
  sx = clampf(cx + radius * std::cos(ang), 0.02f, 0.98f);
  sy = clampf(cy + radius * std::sin(ang), 0.02f, 0.98f);
}

// ─── Per-instance state ────────────────────────────────────────────────
struct State {
  // Params.
  float rate = 0.4f;
  float amplitude = 1.0f;
  float morph_x = 0.5f, morph_y = 0.5f;
  int   metric = 0;
  bool  interpolation = true;
  bool  autopilot = false;
  float ap_speed = 0.3f;
  // Satellites.
  bool  satellites = false;
  float sat_spread = 0.3f;
  float sat_rotation = 0.0f;

  // Runtime.
  double phase = 0.0;     // LFO phase accumulator [0,1)
  float  orbit = 0.0f;    // autopilot orbit accumulator
  float  eff_x = 0.5f, eff_y = 0.5f;
  bool   initialized = false;

  // Curve caches: the center tap + three satellites.
  CurveCache main;
  CurveCache sat[3];
};

static void apply_visibility(const State* s) {
  state::setFieldHidden("ap_speed", !s->autopilot);
  state::setFieldHidden("sat_spread", !s->satellites);
  state::setFieldHidden("sat_rotation", !s->satellites);
}
static void on_state_ready(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) apply_visibility(s);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────
void module_init() {
  state::init("mod.source.spectral_lfo", {1, 0, 0},
    state::Schema()
      // Standard — the live performer reaches for these.
      .floatField("rate", 0.4f, 0.f, 1.f, state::PrimaryInput)        // exp → Hz; 0 = frozen
      .floatField("amplitude", 1.0f, 0.f, 1.f, state::PrimaryInput)   // scales around 0.5
      .floatField("morph_x", 0.5f, 0.f, 1.f, state::PrimaryInput)     // manifold X (t-SNE plane)
      .floatField("morph_y", 0.5f, 0.f, 1.f, state::PrimaryInput)     // manifold Y
      .selectField("metric", 0, state::PrimaryInput,
                   {{"FFT Magnitude", 0}, {"Phase Coherence", 1}, {"Roughness", 2},
                    {"Spectral vs TD", 3}, {"Combined", 4}})
      .boolField("interpolation", true, state::PrimaryInput)          // off = snap to one shape
      // Autopilot — orbit the manifold and broadcast the live position.
      .boolField("autopilot", false, state::PrimaryInput)
      .floatField("ap_speed", 0.3f, 0.f, 1.f, state::PrimaryInput)
      // Manifold position broadcast as outputs — unipolar [0,1]. min/max is the
      // modulation-range contract the UI band draws from (see env_lfo note).
      .floatField("autopilot_x", 0.5f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
      .floatField("autopilot_y", 0.5f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
      // Satellites — three extra taps offset in a triangle around the center.
      .boolField("satellites", false, state::PrimaryInput)
      .floatField("sat_spread", 0.3f, 0.f, 1.f, state::PrimaryInput)    // triangle size
      .floatField("sat_rotation", 0.0f, 0.f, 1.f, state::PrimaryInput)  // full turn
      // Live LFO phase [0,1) — broadcast so the editor can draw a playhead.
      .floatField("phase", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
      // Output — unipolar [0,1] LFO value.
      .floatField("output", 0.0f, 0.f, 1.f, state::PrimaryOutput, "unsigned")
      // Satellite outputs (mirror `output` when satellites are off).
      .floatField("output_a", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
      .floatField("output_b", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
      .floatField("output_c", 0.0f, 0.f, 1.f, state::SecondaryOutput, "unsigned")
      // A multi-channel modulation source: `output` plus the autopilot/phase/
      // satellite scalar outputs are all selectable channels.
      .capability(state::Capability::ModulationSource)
      .capability(state::Capability::ModulationSourceMulti)
  );
  state::log("spectral_lfo: init");
}

void* create() { return new State(); }

void destroy(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  delete s;
}

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  s->initialized = true;
  s->main.valid = false;
  for (int k = 0; k < 3; k++) s->sat[k].valid = false;
  state::setOnStateReady(&on_state_ready);
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s || !s->initialized) return;
  const float fdt = (float)dt;

  // Effective manifold position (autopilot orbit overrides the inputs).
  if (s->autopilot) {
    const float ap_actual = 0.05f + s->ap_speed * s->ap_speed * (1.5f - 0.05f);
    s->orbit -= fdt * ap_actual;
    orbit_xy(s->orbit, s->eff_x, s->eff_y);
  } else {
    s->eff_x = s->morph_x;
    s->eff_y = s->morph_y;
  }

  // Recompute the center curve only when the shape-selecting inputs change.
  ensureCurve(s->main, s->metric, s->eff_x, s->eff_y, s->interpolation);

  // Advance the phase accumulator (rate change never jumps the phase).
  s->phase += dt * rateToHz(s->rate);
  s->phase -= std::floor(s->phase);

  auto sampleAmp = [s](const float* curve) {
    const float v = sampleCurveAt(curve, s->phase);
    return clampf((v - 0.5f) * s->amplitude + 0.5f, 0.0f, 1.0f);
  };

  const float out = sampleAmp(s->main.curve);
  auto vh = val::number(out);
  state::setValPath("output", vh);
  val::release(vh);

  // Satellites — three offset taps; mirror the center output when disabled.
  float sout[3] = { out, out, out };
  if (s->satellites) {
    for (int k = 0; k < 3; k++) {
      float sx, sy;
      satellite_xy(s->eff_x, s->eff_y, s->sat_spread, s->sat_rotation, k, sx, sy);
      ensureCurve(s->sat[k], s->metric, sx, sy, s->interpolation);
      sout[k] = sampleAmp(s->sat[k].curve);
    }
  }
  const char* sat_names[3] = { "output_a", "output_b", "output_c" };
  for (int k = 0; k < 3; k++) {
    auto vs = val::number(sout[k]);
    state::setValPath(sat_names[k], vs);
    val::release(vs);
  }

  // Broadcast the live manifold position.
  auto vx = val::number(s->eff_x);
  state::setValPath("autopilot_x", vx);
  val::release(vx);
  auto vy = val::number(s->eff_y);
  state::setValPath("autopilot_y", vy);
  val::release(vy);
  auto vp = val::number((float)s->phase);
  state::setValPath("phase", vp);
  val::release(vp);
}


void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  bool visibility_changed = false;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* path = pb + off[i];
    const int plen = len[i];
    if      (state::pathIs(path, plen, "rate"))          s->rate = state::patchFloat(i);
    else if (state::pathIs(path, plen, "amplitude"))     s->amplitude = state::patchFloat(i);
    else if (state::pathIs(path, plen, "morph_x"))       s->morph_x = state::patchFloat(i);
    else if (state::pathIs(path, plen, "morph_y"))       s->morph_y = state::patchFloat(i);
    else if (state::pathIs(path, plen, "metric"))        s->metric = (int)state::patchFloat(i);
    else if (state::pathIs(path, plen, "interpolation")) s->interpolation = state::patchFloat(i) != 0.0f;
    else if (state::pathIs(path, plen, "ap_speed"))      s->ap_speed = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sat_spread"))    s->sat_spread = state::patchFloat(i);
    else if (state::pathIs(path, plen, "sat_rotation"))  s->sat_rotation = state::patchFloat(i);
    else if (state::pathIs(path, plen, "autopilot")) {
      bool v = state::patchFloat(i) != 0.0f;
      if (v != s->autopilot) { s->autopilot = v; visibility_changed = true; }
    }
    else if (state::pathIs(path, plen, "satellites")) {
      bool v = state::patchFloat(i) != 0.0f;
      if (v != s->satellites) { s->satellites = v; visibility_changed = true; }
    }
  }
  // Clamp metric to the valid range (guards bad serialized state).
  if (s->metric < 0) s->metric = 0;
  if (s->metric >= SPECTRAL_NUM_METRICS) s->metric = SPECTRAL_NUM_METRICS - 1;
  if (visibility_changed) apply_visibility(s);
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;  // pure data module
}

} // namespace spectral_lfo
