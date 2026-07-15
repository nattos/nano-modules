#pragma once
/*
 * xfade_shape.h — the crossfade `shape` weight family, computed CPU-SIDE.
 *
 * The blend fader (`opacity`) and `shape` are per-dispatch uniforms, so the
 * curve is evaluated on the CPU and the kernels receive the resulting
 * weight(s) as plain floats — the curve math lives HERE (for both the
 * composite.blend effect and the executor's wet/dry pass, host_blend.h) and
 * in ONE TypeScript mirror that draws it: web/src/editors/blend-xfade-math.ts.
 * Keep the two in lock-step.
 *
 * `shape` morphs the fader curve wB(t) — and its mirror wA(t) = wB(1-t) —
 * between three exact anchors:
 *   0.0 — hard linear ramp (the legacy crossfade; both sides at half mid-fade)
 *   0.5 — true equal-power (sin/cos: wA² + wB² = 1, ≈0.707 mid-fade)
 *   1.0 — trapezoid: full by mid-fader, so both sides hold FULL alpha across
 *         the middle; hard linear segments again
 * Between anchors it lerps, giving gentle equal-power-like curves. Endpoints
 * are exact at every shape: wB(0) = 0, wB(1) = 1 — so opacity 0/1 semantics
 * (passthrough / full) never move.
 */

#include <algorithm>
#include <cmath>

namespace xfade {

// B-side (wet/top) fade weight for fader position t under `shape` s.
inline float weightB(float t, float s) {
  t = std::max(0.0f, std::min(1.0f, t));
  s = std::max(0.0f, std::min(1.0f, s));
  const float lin = t;
  const float eqp = std::sin(t * 1.57079632679489662f);
  const float trap = std::min(2.0f * t, 1.0f);
  return (s <= 0.5f) ? lin + (eqp - lin) * (s * 2.0f)
                     : eqp + (trap - eqp) * (s * 2.0f - 1.0f);
}

// A-side (dry/base) fade weight — the same family mirrored.
inline float weightA(float t, float s) { return weightB(1.0f - t, s); }

}  // namespace xfade
