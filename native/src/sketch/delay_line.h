#pragma once
/*
 * delay_line.h — Fixed-capacity time-stamped ring-buffer delay line.
 *
 * Delays a scalar signal by a wall-clock TIME (seconds), independent of the
 * frame rate: push one (clock, value) sample per tick — where `clock` is the
 * accumulated time — then read the value at `clock - delay`. Reads linearly
 * interpolate between the two bracketing samples, so the delayed output stays
 * smooth even as `delay` sweeps or `dt` jitters.
 *
 * Backs the `mod.delay` shaper effect. Header-only and dependency-light so it
 * compiles in the native runtime and any wasm effect bundle. Behavior is pinned
 * by native/tests/test_delay_line.cpp. Lives in the shared executor source tree
 * (not the effect) so a future built-in delay field-option could reuse it, the
 * way param_smoothing.h backs both mod.smooth and FieldOptions.smoothing.
 *
 * CAP bounds the history: it holds the most recent CAP samples, so the maximum
 * resolvable delay is CAP frames' worth of time. A delay older than the buffer
 * holds clamps to the oldest sample (graceful underrun, no garbage).
 */

namespace delay_line {

template <int CAP = 512>
struct DelayLine {
  double t[CAP] = {};   // sample timestamps (monotonically increasing as pushed)
  float  v[CAP] = {};   // sample values
  int    head = 0;      // next write slot
  int    count = 0;     // number of valid samples (<= CAP)

  void reset() { head = 0; count = 0; }

  // Record the current sample. `time` must be non-decreasing across calls.
  void push(double time, float value) {
    t[head] = time;
    v[head] = value;
    head = (head + 1) % CAP;
    if (count < CAP) ++count;
  }

  // Interpolated value at absolute time `target`. Clamps to the newest sample
  // for target >= newest (e.g. delay <= 0) and to the oldest for target older
  // than the buffer holds. Returns 0 only when empty.
  float read(double target) const {
    if (count == 0) return 0.0f;
    const int newest = (head - 1 + CAP) % CAP;
    if (target >= t[newest]) return v[newest];
    int newer = newest;
    for (int i = 1; i < count; ++i) {
      const int older = (newest - i + CAP) % CAP;
      if (t[older] <= target) {
        const double span = t[newer] - t[older];
        const float a = span > 0.0 ? (float)((target - t[older]) / span) : 1.0f;
        return v[older] + (v[newer] - v[older]) * a;
      }
      newer = older;
    }
    const int oldest = (head - count + CAP) % CAP;
    return v[oldest];
  }
};

}  // namespace delay_line
