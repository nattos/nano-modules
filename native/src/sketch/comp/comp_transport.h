// comp_transport.h — the warped real-time playhead.
//
// LOCK-STEP: web/src/views/arrangement/engine/transport-clock.ts
// (TransportController). Semantics must match exactly (shared goldens:
// test_comp_time.cpp ↔ comp-goldens.test.ts).
//
// State is a real-seconds accumulator (`playSeconds`) anchored to the playhead.
// Loop wrap and external scrubs are handled in seconds space so they stay
// warp-correct. One difference in plumbing (not semantics): the TS controller
// memoizes its WarpClock internally off the composition; here the clock is
// owned by the caller (CompExecutor rebuilds it on document changes) and passed
// in, so `reanchor()` sets a flag instead of dropping a memo — the observable
// behavior (re-anchor on the next advance) is identical.

#pragma once

#include <algorithm>
#include <cmath>

#include "warp_curve.h"

namespace comp {

/** The transport surface the controller reads/writes (transport-clock.ts TransportState). */
struct TransportState {
  bool playing = false;
  double positionBeat = 0;
  bool loopEnabled = false;
  double loopStartBeat = 0;
  double loopEndBeat = 0;
};

class TransportController {
 public:
  /**
   * Advance the playhead by `dt` real seconds (no-op while stopped). Re-anchors
   * to `positionBeat` first if it was moved externally (scrub / play-from), so
   * seeking during pause is honored on the next play tick.
   */
  void advance(TransportState& s, const WarpClock& clock, double dt) {
    if (!s.playing) return;

    // Re-sync if the playhead was set behind our back (scrub, play-from, loop
    // bounds change) or a re-anchor was forced (clock rebuilt). Tolerance well
    // under one frame's beat advance.
    if (forceReanchor_ || std::abs(clock.beatAtSeconds(playSeconds_) - s.positionBeat) > 1e-3) {
      playSeconds_ = clock.secondsAt(std::max(0.0, s.positionBeat));
      forceReanchor_ = false;
    }

    const double prevBeat = clock.beatAtSeconds(playSeconds_);
    playSeconds_ += std::max(0.0, dt);
    double beat = clock.beatAtSeconds(playSeconds_);

    // Loop only when we CROSS loopEnd from inside it. A playhead already past
    // loopEnd (e.g. play-from beyond the loop) keeps playing — never yanked back.
    if (s.loopEnabled && s.loopEndBeat > s.loopStartBeat && prevBeat < s.loopEndBeat &&
        beat >= s.loopEndBeat) {
      // Carry the overshoot in seconds so the wrap stays warp-correct.
      const double overshoot = playSeconds_ - clock.secondsAt(s.loopEndBeat);
      playSeconds_ = clock.secondsAt(s.loopStartBeat) + std::max(0.0, overshoot);
      beat = clock.beatAtSeconds(playSeconds_);
    }

    // The store's setPosition clamps to ≥ 0; mirror it here.
    s.positionBeat = std::max(0.0, beat);
  }

  /** Real (warped) seconds at the current playhead — the effect-clock time fed
   *  to the engine each frame. Static while the playhead is (paused → static). */
  double secondsAt(const TransportState& s, const WarpClock& clock) const {
    return clock.secondsAt(std::max(0.0, s.positionBeat));
  }

  /** Force a re-anchor on the next advance (playback (re)start, clock rebuild). */
  void reanchor() { forceReanchor_ = true; }

 private:
  /** Real seconds elapsed to the current playhead (the integration state). */
  double playSeconds_ = 0;
  bool forceReanchor_ = false;
};

}  // namespace comp
