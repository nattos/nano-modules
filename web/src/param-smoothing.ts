/**
 * Parameter smoothing — the linear-ramp math for the engine-level `smoothing`
 * field option (web/src/sketch-types.ts `ParamSmoothing`) and the `mod.smooth`
 * shaper effect.
 *
 * LOCK-STEP twin of native/src/sketch/param_smoothing.h — keep byte-identical
 * (shared goldens: param-smoothing.test.ts + native test_param_smoothing.cpp),
 * exactly like tap-mod.ts ↔ tap_mod.h.
 *
 * Pure + stateful-by-reference so the executor can keep one `SmoothState` per
 * (instance, fieldPath) across frames and the math stays independently unit-
 * testable (mirrors the tap-mod.ts split).
 *
 * Linear, explicit-timer interpolation — NOT exponential. On a target change the
 * timer resets, the current value becomes the ramp start, and the value lerps to
 * the new target over `duration` seconds, then holds. This reaches the target in
 * finite time (no indefinite decay, no subnormal drift, no rubber-banding).
 */

export interface SmoothState {
  /** The target we are currently ramping toward (last seen). */
  target: number;
  /** Value at the most recent timer reset (the ramp start). */
  start: number;
  /** Current interpolated output. */
  current: number;
  /** Seconds elapsed since the timer reset. */
  elapsed: number;
}

/**
 * Seed a smoothing state settled at `value` (elapsed ≥ duration), so a freshly-
 * loaded parameter holds at its value instead of ramping up from 0 on frame one.
 */
export function initSmooth(value: number, duration: number): SmoothState {
  return { target: value, start: value, current: value, elapsed: duration };
}

/**
 * Advance one frame. Resets the timer when `target` changes (start := current);
 * linearly ramps current→target over `duration` seconds; holds at `target` once
 * `elapsed ≥ duration`. `duration ≤ 0` ⇒ instant. Returns the new current value.
 */
export function advanceSmooth(st: SmoothState, target: number, duration: number, dt: number): number {
  if (target !== st.target) {
    st.start = st.current;
    st.target = target;
    st.elapsed = 0;
  }
  st.elapsed += dt;
  const t = duration > 0 ? Math.min(st.elapsed / duration, 1) : 1;
  st.current = st.start + (st.target - st.start) * t;
  return st.current;
}
