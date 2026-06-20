#pragma once
/*
 * param_smoothing.h — Linear-ramp parameter smoothing.
 *
 * This is one half of a LOCK-STEP pair: the math here MUST stay byte-identical to
 * web/src/param-smoothing.ts (shared goldens: test_param_smoothing.cpp +
 * param-smoothing.test.ts), exactly like tap_mod.h ↔ tap-mod.ts. It backs both
 * the engine-level `FieldOptions.smoothing` option and the `mod.smooth` shaper
 * effect, so any host running either must shape the ramp identically.
 *
 * Linear, explicit-timer interpolation — NOT exponential. On a target change the
 * timer resets, the current value becomes the ramp start, and the value lerps to
 * the new target over `duration` seconds, then HOLDS. This reaches the target in
 * finite time (no indefinite decay, no subnormal drift, no rubber-banding).
 *
 * Header-only and dependency-light so it compiles in both the native runtime and
 * any wasm effect bundle without dragging in heavy headers.
 */

namespace param_smoothing {

/// Per-(instance,field) smoothing state, advanced once per frame.
struct SmoothState {
  float target = 0.0f;   ///< Target we are currently ramping toward (last seen).
  float start = 0.0f;    ///< Value at the most recent timer reset (ramp start).
  float current = 0.0f;  ///< Current interpolated output.
  float elapsed = 0.0f;  ///< Seconds elapsed since the timer reset.
};

/// Seed a state settled at `value` (elapsed ≥ duration) so a freshly-loaded
/// parameter holds at its value instead of ramping up from 0 on frame one.
inline SmoothState initSmooth(float value, float duration) {
  return SmoothState{value, value, value, duration};
}

/// Advance one frame. Resets the timer when `target` changes (start := current);
/// linearly ramps current→target over `duration` seconds; holds at `target` once
/// `elapsed ≥ duration`. `duration ≤ 0` ⇒ instant. Returns the new current value.
inline float advanceSmooth(SmoothState& st, float target, float duration, float dt) {
  if (target != st.target) {
    st.start = st.current;
    st.target = target;
    st.elapsed = 0.0f;
  }
  st.elapsed += dt;
  float t = duration > 0.0f ? (st.elapsed / duration) : 1.0f;
  if (t > 1.0f) t = 1.0f;
  st.current = st.start + (st.target - st.start) * t;
  return st.current;
}

}  // namespace param_smoothing
