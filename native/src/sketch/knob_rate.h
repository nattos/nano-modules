#pragma once
/*
 * knob_rate.h — how fast is a knob moving?
 *
 * A boxcar differentiator: displacement over the last `window` seconds, rather
 * than the change since the last frame. That is the whole point of it. A MIDI
 * encoder does not send a smooth ramp; it sends a quantized step every few
 * frames, and differencing per frame reads those steps as full-scale spikes
 * with nothing in between. Displacement over a window reads the true drag
 * speed, is bounded at range/window, and returns to an EXACT zero one window
 * after the motion stops — no exponential tail, so a tight release really is
 * tight.
 *
 * Shared by mod.rig.three_planes' Sweep (which envelopes it into a dimmer and
 * a flicker drive) and source.mesh.three_planes' glints (which take a glint's
 * travel speed straight off it). They want different things downstream, but
 * the measurement is the same measurement, and it is the part with a trap in
 * it — so there is one copy of it and one set of goldens.
 *
 * Host-free: no effect ABI, no allocation. Same arrangement as envelope.h.
 */

namespace knob_rate {

/// Ring capacity. The longest window this is used with (0.4 s) at the ~2 ms
/// frames a headless test runs is ~200 samples; when it fills, the oldest
/// drops and the window shrinks gracefully rather than reporting a wrong span.
constexpr int kRing = 224;

struct KnobRate {
  double clock = 0.0;
  float ring_t[kRing] = {};
  float ring_x[kRing] = {};
  int head = 0;
  int count = 0;
  bool seeded = false;

  void reset() { *this = KnobRate(); }

  /// SIGNED rate in input ranges per second. Call once per tick.
  ///
  /// The first call SEEDS the window at wherever the knob already is: a
  /// sketch's stored value arrives as a real patch before the first tick, and
  /// differencing that against a default would read as an instantaneous
  /// full-throw drag on frame one.
  float sample(float x, float dt, float window) {
    if (!(x == x)) x = ring_count() > 0 ? ring_x[(head - 1 + kRing) % kRing] : 0.0f;
    if (!seeded) {
      seeded = true;
      clock = 0.0;
      ring_t[0] = 0.0f;
      ring_x[0] = x;
      head = 1;
      count = 1;
      return 0.0f;
    }
    if (!(dt > 0.0f)) return 0.0f;
    clock += dt;

    float rate;
    if (window > 1e-3f) {
      rate = windowRate(window, x);
    } else {
      // Window closed: raw per-frame differencing. The sample is still pushed,
      // so a window opened live resumes with history behind it.
      const int prev = (head - 1 + kRing) % kRing;
      rate = (x - ring_x[prev]) / dt;
      windowRate(1e-3f, x);
    }
    return (rate == rate) ? rate : 0.0f;
  }

 private:
  int ring_count() const { return count; }

  /// Displacement over the window ending at (clock, x): evict samples older
  /// than `window` — always keeping one, so the span still covers the whole
  /// window — read the rate against the oldest survivor, then push.
  float windowRate(float window, float x) {
    const float now = (float)clock;
    int oldest = (head - count + kRing) % kRing;
    while (count >= 2) {
      const int next = (oldest + 1) % kRing;
      if (ring_t[next] > now - window) break;   // next would under-span
      oldest = next;
      --count;
    }
    float rate = 0.0f;
    if (count >= 1) {
      const float span = now - ring_t[oldest];
      if (span > 1e-6f) rate = (x - ring_x[oldest]) / span;
    }
    if (count >= kRing) --count;   // full: drop the oldest
    ring_t[head] = now;
    ring_x[head] = x;
    head = (head + 1) % kRing;
    ++count;
    return rate;
  }
};

}  // namespace knob_rate
