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
 * `video.curve`, `video.levels` (gamma), and the noise contrast control.
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

} // namespace fx
