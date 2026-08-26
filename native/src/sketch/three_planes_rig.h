#pragma once
/*
 * three_planes_rig.h — the show logic behind `mod.rig.three_planes`.
 *
 * `source.mesh.three_planes` is deliberately dumb: it projects three stacked
 * quads and shades them, and every rhythmic decision lives outside it. This
 * header IS that outside — an EV meter with peak hold, per-layer flam
 * envelopes, and four one-shot camera moves — kept host-free so the wasm
 * effect and a Catch2 golden run byte-identical code with no GPU and no ABI.
 * Same arrangement as param_smoothing.h / envelope.h / transient_shaper.h.
 *
 * THE FOUR SIGNALS ARE GATES, NOT FADERS. They come from `beatsync`'s Art-Net
 * output (four DMX channels: heavy / regular / decor / uniform), where a hit is
 * a lit window rather than a level — so everything here quantizes at 0.5 and
 * ignores velocity. `level[c]` is what channel `c` means on the meter's axis,
 * not how hard it was struck.
 *
 * THE OUTPUTS ARE NORMALISED, not in the units three_planes shows. A wire drawn
 * by hand carries no `magnitude` key, so the executor folds it into the DEST
 * field's [min,max] (tap_mod.h applyMagnitude, Replace). Publishing the
 * destination slider's *position* is therefore what makes a naive drag land on
 * the right value; kElevationMaxDeg / kSpacingMax mirror three_planes' declared
 * ranges and must be kept in step with its schema.
 */

namespace three_planes_rig {

constexpr int kLayers = 3;
constexpr int kSignals = 4;

/// Mirrors `source.mesh.three_planes`' declared ranges. Its `elevation` field is
/// [0,89] degrees and `plane_spacing` is [0,1.5]; both are what the normalised
/// outputs below divide by. KEEP IN STEP with three_planes/main.cpp's schema.
constexpr float kElevationMaxDeg = 89.0f;
constexpr float kSpacingMax = 1.5f;

/// A frame longer than this is a transport stall, not slow motion — ageing the
/// peak hold by it in one step would blank the meter. Same clamp motion.peak_decay
/// uses for the same reason.
constexpr float kMaxDt = 0.25f;

/// Which one-shot is running. Monophonic: a new trigger replaces the running
/// one outright, which reads as a pop — consistent with the moves themselves.
enum Anim { AnimNone = -1, AnimShow = 0, AnimSweepUp = 1, AnimGlance = 2, AnimUnfold = 3 };
constexpr int kAnimCount = 4;

struct Rgb {
  float r = 0.0f, g = 0.0f, b = 0.0f;
};

inline Rgb lerpRgb(const Rgb& a, const Rgb& b, float t) {
  return Rgb{a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t};
}

/// Everything the card authors. Read fresh each tick — a wire may be moving any
/// of it, so nothing is cached across frames.
struct Params {
  // What each signal means on the meter axis. ch3 and ch4 both name the top.
  float level[kSignals] = {1.0f, 2.0f, 3.0f, 3.0f};

  // Ballistics, all in SECONDS. `*_fall` is seconds to travel ONE level, so the
  // fall reads the same whether it starts from 1 or from 3.
  float meter_fall = 0.35f;
  float peak_hold = 1.2f;
  float peak_fall = 0.9f;

  /// false — every layer under the meter is lit (a solid tower).
  /// true  — a layer is lit only while its own flam runs, so the tower has
  ///         holes. The peak cap still always shows.
  bool allow_holes = false;
  float emission_on = 1.0f;
  float emission_off = 0.12f;

  float flam_time = 0.18f;      ///< seconds
  float flam_color = 1.0f;      ///< how far the flam pushes toward the alternate colour
  float flam_emission = 0.35f;  ///< additive brightness blip, clamped at 1

  Rgb primary{1.00f, 0.22f, 0.62f};    ///< magenta — the flam colour of a plain layer
  Rgb secondary{0.72f, 0.35f, 1.00f};  ///< violet — where a plain layer settles
  Rgb highlight{0.30f, 0.85f, 1.00f};  ///< cyan — where the PEAK CAP settles

  float azimuth_base = 0.125f;                  ///< [0,1] turn, 0.125 = 45 deg
  float elevation_base = 35.264389682754654f;   ///< degrees, true isometric
  float spacing_base = 0.42f;

  float show_time = 1.2f, sweep_time = 1.5f, glance_time = 0.8f, unfold_time = 1.6f;
  float show_azimuth = 30.0f;      ///< total swing, degrees (−half .. +half)
  float glance_azimuth = 30.0f;
  float glance_elevation = 15.0f;  ///< total swing, degrees, travelling DOWN
  float sweep_target = 0.0f;       ///< absolute elevation the sweep ends at, degrees
};

/// One frame of rails. Floats are already normalised for publication.
struct Out {
  float meter = 0.0f;       ///< level/3
  float peak = 0.0f;        ///< level/3
  float anim_phase = 0.0f;  ///< eased 0..1 while a move runs, 0 idle
  float emission[kLayers] = {};
  Rgb color[kLayers] = {};
  float azimuth = 0.0f;    ///< [0,1] turn
  float elevation = 0.0f;  ///< deg / kElevationMaxDeg
  float spacing = 0.0f;    ///< units / kSpacingMax
  int peak_layer = -1;     ///< which layer wears the cap, −1 when the meter is dead
};

namespace detail {

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline float clamp01(float v) { return clampf(v, 0.0f, 1.0f); }
inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }

/// Ease in AND out. The moves pop at their ends on purpose; the easing is only
/// about how the travel between those poses feels.
inline float smoothstep01(float t) {
  t = clamp01(t);
  return t * t * (3.0f - 2.0f * t);
}

/// [0,1) turn, so a sweep past 360 deg wraps instead of clamping at the top.
inline float wrap01(float v) {
  v -= (float)(int)v;
  return v < 0.0f ? v + 1.0f : v;
}

/// Which layer a meter level names. 1.0 → bottom, 2.0 → middle, 3.0 → top; a
/// fractional level rounds UP, so a decaying peak steps down at the integers.
inline int layerOf(float level) {
  int i = (int)level;
  if ((float)i < level) ++i;   // ceil, without pulling in <cmath>
  i -= 1;
  return i < 0 ? 0 : (i >= kLayers ? kLayers - 1 : i);
}

}  // namespace detail

/// The per-instance state. Everything here is an accumulator, which is why the
/// effect declares no temporal capability — it cannot be seeked.
struct Core {
  float meter = 0.0f;
  float peak = 0.0f;
  float hold_t = 0.0f;

  bool prev_on[kSignals] = {};

  float flam_t[kLayers] = {};
  bool flam_live[kLayers] = {};

  int anim = AnimNone;
  float anim_t = 0.0f;
  float anim_dur = 1.0f;

  void reset() { *this = Core(); }

  /// Duration of one move, from the params. Captured at trigger time so a knob
  /// moving mid-move doesn't stretch what is already running.
  static float animDuration(int a, const Params& p) {
    switch (a) {
      case AnimShow:    return p.show_time;
      case AnimSweepUp: return p.sweep_time;
      case AnimGlance:  return p.glance_time;
      case AnimUnfold:  return p.unfold_time;
      default:          return 1.0f;
    }
  }

  /// Start a move. Monophonic — whatever was running is dropped where it stood.
  void trigger(int a, const Params& p) {
    if (a < 0 || a >= kAnimCount) return;
    anim = a;
    anim_t = 0.0f;
    anim_dur = animDuration(a, p);
    if (anim_dur < 1e-4f) anim_dur = 1e-4f;
  }

  /// Advance one frame. `sig` is the raw four-channel feed; it is quantized here.
  Out tick(const Params& p, const float* sig, float dt) {
    using namespace detail;
    if (dt < 0.0f) dt = 0.0f;
    if (dt > kMaxDt) dt = kMaxDt;

    // --- 1. Quantize, and find the rising edges that fire the flams. ---
    float target = 0.0f;
    bool fired[kSignals] = {};
    for (int c = 0; c < kSignals; ++c) {
      const bool on = sig[c] >= 0.5f;
      fired[c] = on && !prev_on[c];
      prev_on[c] = on;
      if (on && p.level[c] > target) target = p.level[c];
    }

    // --- 2. Meter: instant attack, timed fall. A hit is a step, not a ramp —
    //        the whole point of a meter is that you see the transient. ---
    if (target > meter) {
      meter = target;
    } else {
      const float fall = p.meter_fall > 1e-4f ? p.meter_fall : 1e-4f;
      meter -= dt / fall;
      if (meter < 0.0f) meter = 0.0f;
    }

    // --- 3. Peak hold. Rearms whenever the meter reaches it, then sits for
    //        `peak_hold` seconds before falling. Never below the meter. ---
    if (meter >= peak) {
      peak = meter;
      hold_t = 0.0f;
    } else {
      hold_t += dt;
      if (hold_t > p.peak_hold) {
        const float fall = p.peak_fall > 1e-4f ? p.peak_fall : 1e-4f;
        peak -= dt / fall;
        if (peak < meter) peak = meter;
      }
    }

    // --- 4. Flams. A fire lands on the layer its LEVEL names, so ch3 and ch4
    //        share the top layer and retrigger each other. ---
    for (int c = 0; c < kSignals; ++c) {
      if (!fired[c]) continue;
      const int i = layerOf(p.level[c]);
      flam_t[i] = 0.0f;
      flam_live[i] = true;
    }
    const float ft = p.flam_time > 1e-4f ? p.flam_time : 1e-4f;
    float flam[kLayers] = {};
    for (int i = 0; i < kLayers; ++i) {
      if (!flam_live[i]) continue;
      const float k = 1.0f - flam_t[i] / ft;   // 1 at the hit, 0 at retirement
      flam[i] = k > 0.0f ? k * k : 0.0f;       // ease out — a blip, not a fade
      flam_t[i] += dt;
      if (flam_t[i] >= ft) flam_live[i] = false;
    }

    Out o;
    o.meter = clamp01(meter / (float)kLayers);
    o.peak = clamp01(peak / (float)kLayers);

    // --- 5. Which layers are lit. `allow_holes` swaps "everything under the
    //        meter" for "only what is currently flamming"; the cap is exempt
    //        either way, because a cap you cannot see is not a cap. ---
    o.peak_layer = peak >= 0.05f ? layerOf(peak) : -1;
    bool lit[kLayers] = {};
    for (int i = 0; i < kLayers; ++i)
      lit[i] = p.allow_holes ? (flam[i] > 0.0f) : (meter >= (float)(i + 1) - 1e-4f);
    if (o.peak_layer >= 0) lit[o.peak_layer] = true;

    // --- 6. Emission and colour. The cap's flam runs the OTHER WAY: a plain
    //        layer rests dark-violet and flashes magenta, the cap rests cyan and
    //        flashes violet, so the top of the tower never reads like the rest
    //        of it even mid-hit. ---
    for (int i = 0; i < kLayers; ++i) {
      const float base = lit[i] ? p.emission_on : p.emission_off;
      o.emission[i] = clamp01(base + flam[i] * p.flam_emission);
      const float mix = clamp01(flam[i] * p.flam_color);
      o.color[i] = (i == o.peak_layer) ? lerpRgb(p.highlight, p.secondary, mix)
                                       : lerpRgb(p.secondary, p.primary, mix);
    }

    // --- 7. The camera move. Half a cycle, no return: it pops into its start
    //        pose, eases across, and pops back to baseline when the timer runs
    //        out. Both pops are the effect, not an artefact. ---
    float az_deg = 0.0f;
    float elev_deg = 0.0f;
    float spacing = p.spacing_base;
    if (anim != AnimNone) {
      anim_t += dt;
      if (anim_t >= anim_dur) {
        anim = AnimNone;   // POP back to baseline
      } else {
        const float u = smoothstep01(anim_t / anim_dur);
        o.anim_phase = u;
        switch (anim) {
          case AnimShow:
            az_deg = lerpf(-p.show_azimuth * 0.5f, p.show_azimuth * 0.5f, u);
            break;
          case AnimGlance:
            az_deg = lerpf(-p.glance_azimuth * 0.5f, p.glance_azimuth * 0.5f, u);
            // Travels DOWN across the move, hence the high-to-low order.
            elev_deg = lerpf(p.glance_elevation * 0.5f, -p.glance_elevation * 0.5f, u);
            break;
          case AnimSweepUp:
            // Absolute endpoint, not a swing: baseline → `sweep_target` (0 deg
            // by default, the side-on pose), then a pop back.
            elev_deg = lerpf(0.0f, p.sweep_target - p.elevation_base, u);
            break;
          case AnimUnfold:
            // The one move that LANDS on baseline, so it has no end-pop.
            spacing = lerpf(0.0f, p.spacing_base, u);
            break;
          default:
            break;
        }
      }
    }

    // --- 8. Normalise for publication (see the header note). ---
    o.azimuth = wrap01(p.azimuth_base + az_deg / 360.0f);
    o.elevation = clamp01((p.elevation_base + elev_deg) / kElevationMaxDeg);
    o.spacing = clamp01(spacing / kSpacingMax);
    return o;
  }
};

}  // namespace three_planes_rig
