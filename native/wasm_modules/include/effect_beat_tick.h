#pragma once
/*
 * effect_beat_tick.h — Bar-phase → beat-multiplied tick counter.
 *
 * Wraps the §2.2 style-guide pattern:
 *
 *   double dphase = barPhase - prev + 1.0; if (dphase >= 1) dphase -= 1;
 *   effective_beats += dphase * beat_multiplier;
 *   // fire on every integer crossing of effective_beats
 *
 * `beat_multiplier` is the number of ticks per bar — typical values
 * are 0.25, 0.5, 1.0, 2.0, 4.0 (a select-field in the calling effect).
 *
 * First frame is a no-op: we don't know dphase yet, so we seed
 * `prev_bar_phase_` and return 0. This avoids a spurious tick on init.
 *
 * Backward jumps in barPhase (host restart / scrub) are treated as
 * tiny forward advances — dphase stays in [0, 1), which matches the
 * §2.2 wrap-handling math exactly. We never emit negative crossings.
 *
 * Usage:
 *
 *   #include <effect_beat_tick.h>
 *
 *   static fx::BeatTick s_tick;
 *   static float s_beat_multiplier = 1.0f;
 *
 *   void tick(double dt) {
 *     int crossings = s_tick.tick(s_beat_multiplier);
 *     if (crossings > 0) {
 *       // fire trigger — orthomod snaps linear_env to 1
 *     }
 *   }
 */

#include <host.h>

namespace fx {

class BeatTick {
public:
  /**
   * Call once per frame. Returns the number of integer crossings of
   * `effective_beats` since the previous call — typically 0 or 1, but
   * can be >1 if `dt * beat_multiplier > 1` (very high multiplier or
   * a long frame stall).
   *
   * `beat_multiplier <= 0` disables ticking and returns 0.
   */
  int tick(float beat_multiplier) {
    if (beat_multiplier <= 0.0f) return 0;
    double bp = host::barPhase();
    if (prev_bar_phase_ < 0.0) {
      prev_bar_phase_ = bp;
      effective_beats_ = 0.0;
      last_int_ = 0;
      return 0;
    }
    double dphase = bp - prev_bar_phase_ + 1.0;
    if (dphase >= 1.0) dphase -= 1.0;
    prev_bar_phase_ = bp;
    effective_beats_ += dphase * (double)beat_multiplier;
    long cur_int = (long)effective_beats_;
    long delta = cur_int - last_int_;
    last_int_ = cur_int;
    return delta > 0 ? (int)delta : 0;
  }

  /// Re-arm. Next `tick()` reseeds prev_bar_phase from the host and
  /// returns 0. Call when the effect re-initializes or after a long
  /// pause where you want to drop accumulated beat state.
  void reset() {
    prev_bar_phase_ = -1.0;
    effective_beats_ = 0.0;
    last_int_ = 0;
  }

  /// Total fractional beats since reset/init — useful for effects that
  /// want to drive a continuous phase off the beat clock instead of (or
  /// in addition to) discrete triggers.
  double effectiveBeats() const { return effective_beats_; }

private:
  double prev_bar_phase_ = -1.0;   // sentinel: -1 = uninitialized
  double effective_beats_ = 0.0;
  long   last_int_ = 0;
};

} // namespace fx
