/*
 * data.spectral_lfo — spectral-morph LFO generator.
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

#include "spectral_morph.h"
#include "spectral_lfo_atlas.h"

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
// spread ∈ [0,1] → orbit radius in t-SNE space; rotation ∈ [0,1] → full turn.
// NOTE: the web inspector mirrors this layout (spectral-lfo-inspector.ts).
static const float kSatRadiusMax = 0.45f;
static const float kTwoPi        = 6.2831853071795864f;
static const float kThirdTurn    = 2.0943951023931953f;  // 2π/3
static inline void satellite_xy(float cx, float cy, float spread, float rotation,
                                int k, float& sx, float& sy) {
  const float radius = spread * kSatRadiusMax;
  const float ang = rotation * kTwoPi + (float)k * kThirdTurn;
  sx = clampf(cx + radius * std::cos(ang), 0.02f, 0.98f);
  sy = clampf(cy + radius * std::sin(ang), 0.02f, 0.98f);
}

// A rasterized LFO curve plus the key it was computed for — recomputed only
// when (x, y, metric, interpolation) change.
struct CurveCache {
  bool  valid = false;
  float x = -1.0f, y = -1.0f;
  int   metric = -1;
  bool  interp = true;
  float curve[SPEC_N];
};

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

// ─── Triangle lookup (port of findTriangle) ────────────────────────────
struct TriHit { int verts[3]; double weights[3]; };

static bool findTriangle(int metric, double tx, double ty, TriHit& hit) {
  const float* coords = SL_COORDS[metric];
  const int*   tris   = SL_TRIS[metric];
  const int*   toData = SL_TRITODATA[metric];
  const int    ntris  = SL_NTRIS[metric];
  for (int t = 0; t < ntris; t++) {
    const int a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    double bary[3];
    if (!barycentric(tx, ty,
                     coords[a * 2], coords[a * 2 + 1],
                     coords[b * 2], coords[b * 2 + 1],
                     coords[c * 2], coords[c * 2 + 1], bary))
      continue;
    if (bary[0] >= -0.001 && bary[1] >= -0.001 && bary[2] >= -0.001) {
      const double w0 = std::max(0.0, bary[0]);
      const double w1 = std::max(0.0, bary[1]);
      const double w2 = std::max(0.0, bary[2]);
      const double sum = w0 + w1 + w2;
      hit.verts[0] = toData[a]; hit.verts[1] = toData[b]; hit.verts[2] = toData[c];
      hit.weights[0] = w0 / sum; hit.weights[1] = w1 / sum; hit.weights[2] = w2 / sum;
      return true;
    }
  }
  return false;
}

// Nearest real data point — fallback when no triangle contains the query.
static int nearestData(int metric, double tx, double ty) {
  const float* coords = SL_COORDS[metric];
  double best = 1e300; int bestIdx = 0;
  for (int i = 0; i < SL_NUM_ENTRIES; i++) {
    const double dx = coords[i * 2] - tx, dy = coords[i * 2 + 1] - ty;
    const double d = dx * dx + dy * dy;
    if (d < best) { best = d; bestIdx = i; }
  }
  return bestIdx;
}

// Rasterize a single shape (entry) into `out` (SPEC_N samples).
static void evalEntry(int entry, float* out) {
  const int off = SL_ENTRY_OFFSET[entry];
  const int np  = SL_ENTRY_NCP[entry];
  evaluateCurve(SL_CP_X + off, SL_CP_Y + off, SL_CP_F + off, np, out, SPEC_N);
}

// Compute the LFO curve for a position (eff, metric, interpolation) into `out`.
static void computeCurve(int metric, double ex, double ey, bool interp, float* out) {
  TriHit hit;
  if (!findTriangle(metric, ex, ey, hit)) {
    const int n = nearestData(metric, ex, ey);
    hit.verts[0] = hit.verts[1] = hit.verts[2] = n;
    hit.weights[0] = 1.0; hit.weights[1] = hit.weights[2] = 0.0;
  }

  if (!interp) {
    // Snap to the dominant (max-weight) shape.
    int best = 0;
    if (hit.weights[1] > hit.weights[best]) best = 1;
    if (hit.weights[2] > hit.weights[best]) best = 2;
    evalEntry(hit.verts[best], out);
    return;
  }

  // Spectral morph of the 3 shapes.
  static float c0[SPEC_N], c1[SPEC_N], c2[SPEC_N];
  static double m0[SPEC_N], p0[SPEC_N], m1[SPEC_N], p1[SPEC_N], m2[SPEC_N], p2[SPEC_N];
  evalEntry(hit.verts[0], c0);
  evalEntry(hit.verts[1], c1);
  evalEntry(hit.verts[2], c2);
  curveToSpectrum(c0, m0, p0);
  curveToSpectrum(c1, m1, p1);
  curveToSpectrum(c2, m2, p2);
  const double* mags[3]   = { m0, m1, m2 };
  const double* phases[3] = { p0, p1, p2 };

  float raw[SPEC_N];
  // Web defaults: sigma=0, phaseCoherence=1, geoStraighten=1.
  blendSpectra(mags, phases, hit.weights, /*sigma=*/0.0, /*phaseCoherence=*/1.0, raw);
  geometricStraighten(raw, SPEC_N, out, /*strength=*/1.0);
  for (int i = 0; i < SPEC_N; i++) out[i] = clampf(out[i], 0.0f, 1.0f);
}

// Recompute a cache only when its (x, y, metric, interpolation) key changes.
static void ensureCurve(CurveCache& c, int metric, float ex, float ey, bool interp) {
  if (c.valid && ex == c.x && ey == c.y && metric == c.metric && interp == c.interp) return;
  computeCurve(metric, ex, ey, interp, c.curve);
  c.valid = true; c.x = ex; c.y = ey; c.metric = metric; c.interp = interp;
}

// Sample a cached curve at the given phase (linear, looping).
static inline float sampleCurveAt(const float* curve, double phase) {
  const double p = phase * SPEC_N;
  int i0 = (int)std::floor(p);
  const double frac = p - i0;
  i0 = ((i0 % SPEC_N) + SPEC_N) % SPEC_N;
  const int i1 = (i0 + 1) % SPEC_N;
  return (float)(curve[i0] + (curve[i1] - curve[i0]) * frac);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────
void module_init() {
  state::init("data.spectral_lfo", {1, 0, 0},
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
      .floatField("autopilot_x", 0.5f, 0.f, 1.f, state::SecondaryOutput)
      .floatField("autopilot_y", 0.5f, 0.f, 1.f, state::SecondaryOutput)
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

void on_resolume_param(void*, long long, double) {}

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
  if (s->metric >= SL_NUM_METRICS) s->metric = SL_NUM_METRICS - 1;
  if (visibility_changed) apply_visibility(s);
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;  // pure data module
}

} // namespace spectral_lfo
