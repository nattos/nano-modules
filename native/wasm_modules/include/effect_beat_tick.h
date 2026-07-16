#pragma once
/*
 * effect_beat_tick.h — Bar-phase → beat-multiplied tick counter, LOCKED to the
 * transport grid.
 *
 * Ticks fire on integer crossings of the ABSOLUTE grid position
 *
 *   effective_beats = (bars_since_seed + barPhase) * beat_multiplier
 *
 * so at multiplier 4 the ticks land exactly on the host's beats (barPhase
 * 0, 0.25, 0.5, 0.75), at multiplier 1 exactly on the bar line, and so on —
 * NOT merely spaced 1/multiplier apart from whenever the counter was armed.
 * `beat_multiplier` is the number of ticks per bar — typical values are
 * 0.25, 0.5, 1.0, 2.0, 4.0 (a select-field in the calling effect).
 *
 * Sub-bar multipliers (>= 1) are therefore fully phase-locked. Multi-bar
 * multipliers (< 1, e.g. 0.25 = every 4 bars) fire ON a bar line, but which
 * bar starts the group is counted from the seed bar — the host only exposes
 * the phase within one bar, not an absolute bar index.
 *
 * First frame seeds from the current bar phase and returns 0 — no spurious
 * tick on init; the first fire is the next grid line. A mid-flight
 * multiplier change (live division edit) re-seeds the crossing counter the
 * same way: no burst, next new-grid line fires.
 *
 * Backward jumps in barPhase: a wrap (large drop, the normal end-of-bar
 * case) advances the bar counter; a small backward scrub rewinds the grid
 * position, emits nothing, and re-fires lines as they are passed again.
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
#include <cmath>

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
    if (beat_multiplier <= 0.0f) {
      prev_mult_ = beat_multiplier;
      return 0;
    }
    double bp = host::barPhase();
    if (prev_bar_phase_ < 0.0) {
      // Seed from the CURRENT grid position so later crossings sit on the
      // transport grid (not offset by the arm time).
      prev_bar_phase_ = bp;
      bars_ = 0;
      effective_beats_ = bp * (double)beat_multiplier;
      last_int_ = (long)std::floor(effective_beats_);
      prev_mult_ = beat_multiplier;
      return 0;
    }
    double d = bp - prev_bar_phase_;
    if (d < -0.5) bars_++;   // wrapped into the next bar
    prev_bar_phase_ = bp;
    effective_beats_ = ((double)bars_ + bp) * (double)beat_multiplier;
    long cur_int = (long)std::floor(effective_beats_);
    if (beat_multiplier != prev_mult_) {
      // Division changed mid-flight: re-seed the counter on the new grid so
      // the jump neither bursts nor swallows ticks; the next NEW-grid line fires.
      prev_mult_ = beat_multiplier;
      last_int_ = cur_int;
      return 0;
    }
    long delta = cur_int - last_int_;
    last_int_ = cur_int;
    return delta > 0 ? (int)delta : 0;
  }

  /// Re-arm. Next `tick()` reseeds from the host's current bar phase and
  /// returns 0. Call when the effect re-initializes or after a long
  /// pause where you want to drop accumulated beat state.
  void reset() {
    prev_bar_phase_ = -1.0;
    effective_beats_ = 0.0;
    last_int_ = 0;
    bars_ = 0;
    prev_mult_ = 0.0f;
  }

  /// The absolute grid position: (bars since seed + barPhase) * multiplier.
  /// Phase-locked to the transport — integer values ARE grid lines. Useful
  /// for effects that drive a continuous phase off the beat clock, or run
  /// their own offset crossing detector (trigger_beat's Phase knob).
  double effectiveBeats() const { return effective_beats_; }

private:
  double prev_bar_phase_ = -1.0;   // sentinel: -1 = uninitialized
  double effective_beats_ = 0.0;
  long   last_int_ = 0;
  long   bars_ = 0;                // bar-wrap counter since seed
  float  prev_mult_ = 0.0f;        // detects live division edits
};

} // namespace fx
