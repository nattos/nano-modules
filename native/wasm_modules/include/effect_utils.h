#pragma once
/*
 * effect_utils.h — Common helpers for nano effect modules.
 *
 * Header-only. See EFFECTS_STYLE_GUIDE.md for the design rationale behind
 * each helper. Keep this file small — only extract patterns that occur
 * in three or more effects.
 */

#include <cmath>

namespace fx {

/**
 * Map a signed normalized slider [-1, +1] to a power-curve exponent.
 *
 *   slider -1  →  exp 2^range          (heavy crush)
 *   slider  0  →  exp 1                (identity)
 *   slider +1  →  exp 1 / 2^range      (heavy lift)
 *
 * `range = 3.0` (default) gives the standard 8↔1↔1/8 mapping used by
 * `color.tone.curve`, `color.tone.levels` (gamma), and the noise contrast control.
 */
inline float signedSliderToExp(float slider, float range = 3.0f) {
  return std::pow(2.0f, -slider * range);
}

/**
 * Multiplicative gain measured in stops. `slider` ∈ [-1, +1] maps to
 * `[-maxStops, +maxStops]` stops, so the returned gain is in
 * `[2^-maxStops, 2^+maxStops]`. Default ±3 stops → gain in [1/8, 8].
 */
inline float stops(float slider, float maxStops = 3.0f) {
  return std::pow(2.0f, slider * maxStops);
}

/**
 * Cover-square half-extents in viewport-uv units. See style guide §1.5.
 *
 *   ax = max(W, H) / (2 * W)
 *   ay = max(W, H) / (2 * H)
 *
 * Use these as the `aspect_x` / `aspect_y` uniforms passed to shaders that
 * sample in cover-square coordinates.
 */
struct CoverSquare {
  float ax;
  float ay;
};

inline CoverSquare coverSquare(int vp_w, int vp_h) {
  float vw = static_cast<float>(vp_w);
  float vh = static_cast<float>(vp_h);
  float side = vw > vh ? vw : vh;
  return { side / (2.0f * vw), side / (2.0f * vh) };
}

/**
 * SkipJog — a C2-continuous "skip the empty stretches" engagement ramp.
 *
 * Procedural generators sometimes wander into long dead patches (a flat field, a
 * hole in the atlas) that render as near-solid colour. Feed this a `content`
 * signal in [0, 1] (1 = a rich frame, 0 = empty) each frame and it drives an
 * `engaged` value in [0, 1]: it eases IN when content drops below `lo` and eases
 * back OUT once content climbs above `hi` (the two thresholds give hysteresis so
 * it doesn't chatter at the boundary).
 *
 * `engaged` is `smootherstep(phase)` where `phase` advances LINEARLY in time, so
 * multiplying it by any jog rate — a time-clock speed-up, an orbit-speed boost —
 * yields motion that is C2 in time: smootherstep has zero 1st AND 2nd derivative
 * at both ends, so acceleration is continuous through engage/disengage. No pops.
 *
 * The engage and disengage ramps are INDEPENDENT (`ramp_in_s` / `ramp_out_s`):
 * a gentle glide into the skip, and — since disengaging means a live frame has
 * returned and we're leaving a solid colour — a quicker slowdown out of it. It
 * stays smooth because the switch happens near full engagement, where
 * smootherstep is already flat, so a faster out-ramp introduces no visible kink.
 *
 * Usage each frame (in tick):
 *   float e = jog.update(content, lo, hi, ramp_in, ramp_out, dt);
 *   clock  += dt * (base_rate + e * jog_rate);   // jog a time clock forward
 *   orbit  += dt * e * orbit_boost;              // …or accelerate an orbit
 *
 * `rising()` reports the frame the ramp first crosses ~half engagement while
 * climbing — a convenient one-shot edge for firing a discrete action (e.g. a
 * snap) exactly once per empty stretch.
 */
struct SkipJog {
  float phase   = 0.0f;   // engagement phase [0,1], advanced linearly in time
  float engaged = 0.0f;   // smootherstep(phase) — the C2 output
  bool  armed   = true;   // one-shot latch for rising() (re-arms once disengaged)
  bool  rose    = false;  // set on the frame rising() should report true

  // content: current interestingness [0,1]. lo/hi: engage below lo, disengage
  // above hi (hi > lo for hysteresis). ramp_in_s / ramp_out_s: seconds for a full
  // 0→1 (engage) resp. 1→0 (disengage) sweep of the phase. dt: frame delta
  // (seconds). Returns `engaged`.
  float update(float content, float lo, float hi, float ramp_in_s,
               float ramp_out_s, float dt) {
    float target = (content < lo) ? 1.0f : (content > hi ? 0.0f : phase);
    float prev = phase;
    if (phase < target) {
      float step = (ramp_in_s > 1e-3f) ? (dt / ramp_in_s) : 1.0f;
      phase = phase + step < target ? phase + step : target;
    } else if (phase > target) {
      float step = (ramp_out_s > 1e-3f) ? (dt / ramp_out_s) : 1.0f;
      phase = phase - step > target ? phase - step : target;
    }
    if (phase < 0.0f) phase = 0.0f; else if (phase > 1.0f) phase = 1.0f;
    float t = phase;
    engaged = t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);   // smootherstep (C2)
    // Rising edge past half-engagement, one-shot until we fully disengage.
    rose = false;
    if (armed && phase >= 0.5f && prev < 0.5f) { rose = true; armed = false; }
    if (phase <= 0.05f) armed = true;
    return engaged;
  }

  // True exactly on the frame the ramp first crosses half-engagement climbing.
  bool rising() const { return rose; }
};

} // namespace fx
