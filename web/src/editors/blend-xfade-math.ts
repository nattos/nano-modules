/**
 * Crossfade `shape` weight family — TS mirror, used ONLY to DRAW the curve
 * (the engine computes the weights CPU-side in C++). Keep in lock-step with
 * native/src/sketch/xfade_shape.h (the one C++ home, consumed by both the
 * composite.blend effect and the executor's wet/dry pass, host_blend.h).
 *
 * `shape` morphs the fader curve wB(t) — and its mirror wA(t) = wB(1-t) —
 * between three exact anchors:
 *   0.0 — hard linear ramp (the legacy crossfade; both sides at half mid-fade)
 *   0.5 — true equal-power (sin/cos: wA² + wB² = 1, ≈0.707 mid-fade)
 *   1.0 — trapezoid: full by mid-fader, so both sides hold FULL alpha across
 *         the middle; hard linear segments again
 * Between anchors it lerps, giving gentle equal-power-like curves. Endpoints
 * are exact at every shape: wB(0) = 0, wB(1) = 1.
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** B-side (wet/top) fade weight for fader position t under `shape` s. */
export function xfadeWeightB(t: number, s: number): number {
  t = clamp01(t);
  s = clamp01(s);
  const lin = t;
  const eqp = Math.sin(t * Math.PI * 0.5);
  const trap = Math.min(2 * t, 1);
  return s <= 0.5 ? lin + (eqp - lin) * (s * 2)
                  : eqp + (trap - eqp) * (s * 2 - 1);
}

/** A-side (dry/base) fade weight — the same family mirrored. */
export function xfadeWeightA(t: number, s: number): number {
  return xfadeWeightB(1 - t, s);
}
