/**
 * TransportController — the warped real-time playhead (Component E wired into the
 * transport).
 *
 * The grid already renders beats in warped units (`WarpCurve`); `WarpClock` maps
 * those units to real seconds. This controller advances `positionBeat` in REAL
 * time through that map, so the playhead moves at warped speed — faster where the
 * grid clumps (tempo > base), slower where it spreads — instead of a flat
 * beats/second. It is the playback-side twin of the grid's render-side warp:
 * one `WarpCurve`, two consumers.
 *
 * State is a real-seconds accumulator (`playSeconds`) anchored to the playhead.
 * Loop wrap and external scrubs (play-from, click-to-seek) are handled in seconds
 * space so they stay warp-correct. No engine/worker dependency — the executor
 * free-runs a live preview; precise seek-to-beat (positioning the executor at the
 * exact warped frame) needs a worker seek command and is a later step.
 */

import { WarpClock, makeWarpClock } from './warp-clock';
import { derivedWarpSegments, type Composition } from '../model/composition';

/** The transport surface this controller reads/writes (the store, structurally). */
export interface TransportState {
  playing: boolean;
  positionBeat: number;
  loopEnabled: boolean;
  loopStartBeat: number;
  loopEndBeat: number;
  composition: Composition;
  setPosition(beat: number): void;
}

/** Cheap signature of the warp-relevant inputs; rebuild the clock when it flips. */
function warpSignature(comp: Composition): string {
  const segs = derivedWarpSegments(comp);
  // bpm + per-segment shape. Segments are few, so JSON is fine and cheap.
  return `${comp.meta.baseBPM}|${JSON.stringify(segs)}`;
}

export class TransportController {
  private clock: WarpClock | null = null;
  private clockSig = '';
  /** Real seconds elapsed to the current playhead (the integration state). */
  private playSeconds = 0;

  /** Memoized warp clock; rebuilt only when the warp inputs change. */
  private ensureClock(comp: Composition): WarpClock {
    const sig = warpSignature(comp);
    if (!this.clock || sig !== this.clockSig) {
      this.clock = makeWarpClock(comp);
      this.clockSig = sig;
    }
    return this.clock;
  }

  /**
   * Advance the playhead by `dt` real seconds (no-op while stopped). Re-anchors
   * to `positionBeat` first if it was moved externally (scrub / play-from), so
   * seeking during pause is honored on the next play tick.
   */
  advance(s: TransportState, dt: number) {
    if (!s.playing) return;
    const clock = this.ensureClock(s.composition);

    // Re-sync if the playhead was set behind our back (scrub, play-from, loop
    // bounds change). Tolerance well under one frame's beat advance.
    if (Math.abs(clock.beatAtSeconds(this.playSeconds) - s.positionBeat) > 1e-3) {
      this.playSeconds = clock.secondsAt(Math.max(0, s.positionBeat));
    }

    const prevBeat = clock.beatAtSeconds(this.playSeconds);
    this.playSeconds += Math.max(0, dt);
    let beat = clock.beatAtSeconds(this.playSeconds);

    // Loop only when we CROSS loopEnd from inside it. A playhead already past
    // loopEnd (e.g. play-from beyond the loop) keeps playing — never yanked back.
    if (s.loopEnabled && s.loopEndBeat > s.loopStartBeat
        && prevBeat < s.loopEndBeat && beat >= s.loopEndBeat) {
      // Carry the overshoot in seconds so the wrap stays warp-correct.
      const overshoot = this.playSeconds - clock.secondsAt(s.loopEndBeat);
      this.playSeconds = clock.secondsAt(s.loopStartBeat) + Math.max(0, overshoot);
      beat = clock.beatAtSeconds(this.playSeconds);
    }

    s.setPosition(beat);
  }

  /** Real (warped) seconds at the current playhead — the effect-clock time fed
   *  to the engine each frame. Static while the playhead is (paused → static). */
  secondsAt(s: TransportState): number {
    return this.ensureClock(s.composition).secondsAt(Math.max(0, s.positionBeat));
  }

  /** Force a re-anchor on the next advance (e.g. when playback (re)starts). */
  reanchor() {
    this.clock = null; // also drops the memo so a bpm change mid-pause is picked up
    this.clockSig = '';
  }
}
