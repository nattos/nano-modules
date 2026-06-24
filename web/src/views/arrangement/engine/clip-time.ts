/**
 * clip-time.ts — the read-side beat→source-time mapper for video clips.
 *
 * Given a clip's {@link ClipLoopConfig} (a source SLICE in neutral-speed seconds +
 * a play mode) and where the transport is (an arrangement `beat`), compute WHICH
 * second of the source file to display — or `null` to render transparent. The video
 * pump (engine/video-compositor.ts) turns that into a frame index and injects it.
 *
 * Pure: no engine / DOM / GPU deps. Warp enters only through `ctx.secondsAt` (the
 * offline beat⇄seconds map, engine/warp-clock.ts), so the grid render and playback
 * seeking share one source of truth, and the whole thing is unit-testable in beat space.
 *
 * The math (per the play-mode spec):
 *   elapsedSec = secondsAt(beat) − secondsAt(startBeat)   // real seconds into the clip
 *   localBeat  = beat − startBeat
 *   loopLen    = endSec − startSec                          // slice length at neutral speed
 *
 *   one-shot : vt = startSec ± speed·elapsedSec ; transparent off the file ends.
 *   time     : vt = startSec + fold(±speed·elapsedSec, loopLen) ; loops with BPM + length.
 *   beat-sync: vt = startSec + fold(±localBeat, videoBeats)/videoBeats · loopLen ; the loop
 *              count is locked to beats (BPM-independent) and the speed floats instead.
 */

import type { ClipLoopConfig } from '../model/composition';

/** Everything the mapper needs about a clip's placement + its source, besides the loop config. */
export interface ClipTimeCtx {
  /** Clip start on the arrangement timeline, in beats. */
  startBeat: number;
  /** Clip length on the timeline, in beats. */
  lengthBeat: number;
  /** Full source duration in seconds (frameCount / fps). */
  videoDurSec: number;
  /** Warp-aware beat→real-seconds (WarpClock.secondsAt). For an un-warped clock this
   *  is just `beat · 60/bpm`. */
  secondsAt: (beat: number) => number;
}

const EPS = 1e-9;

/**
 * Fold a position `x` into `[0, period)` — wrap for a normal loop, or reflect over
 * `2·period` for ping-pong. Ping-pong is anchored at 0 (the slice start is the "ping",
 * playing forward), so the first half-period plays forward and the next reverses.
 */
function fold(x: number, period: number, pingpong: boolean): number {
  if (period <= EPS) return 0;
  if (!pingpong) return ((x % period) + period) % period;
  const span = 2 * period;
  const m = ((x % span) + span) % span;
  return m < period ? m : span - m;
}

/**
 * The source time (seconds into the file) to display at arrangement `beat`, or `null`
 * to render transparent. `random` is not implemented yet (Phase 3) and falls through
 * to `time`-like looping so a random clip still shows something.
 */
export function clipSourceTimeAt(
  loop: ClipLoopConfig,
  ctx: ClipTimeCtx,
  beat: number,
): number | null {
  const startSec = loop.startSec ?? 0;
  const speed = loop.speed ?? 1;
  const dir = loop.direction === 'reverse' ? -1 : 1;
  const elapsedSec = ctx.secondsAt(beat) - ctx.secondsAt(ctx.startBeat);

  if (loop.mode === 'one-shot') {
    // Plays once; the end-into-source free-floats. Off either file end ⇒ transparent.
    const vt = startSec + dir * speed * elapsedSec;
    if (vt < -EPS || vt >= ctx.videoDurSec - EPS) return null;
    return vt;
  }

  // Looping modes need a finite slice.
  const endSec = loop.endSec ?? ctx.videoDurSec;
  const loopLen = endSec - startSec;
  if (loopLen <= EPS) return startSec;

  if (loop.mode === 'beat-sync') {
    // Loop count locked to beats (BPM-independent): one loop spans `videoBeats` beats.
    const videoBeats = loop.syncUseBpm
      ? loopLen * ((loop.syncBpm ?? 120) / 60)
      : loop.syncBeats ?? 4;
    if (videoBeats <= EPS) return startSec;
    const localBeat = beat - ctx.startBeat;
    const phase = fold(dir * localBeat, videoBeats, loop.pingpong ?? false) / videoBeats;
    return startSec + phase * loopLen;
  }

  // 'time' (and the Phase-3 'random' stand-in): loop count follows clip length × BPM.
  const consumed = dir * speed * elapsedSec;
  return startSec + fold(consumed, loopLen, loop.pingpong ?? false);
}

/**
 * The source FRAME to display at `beat`, or `null` (transparent). `floor` of the
 * source second × fps — so when frame rates align (e.g. a 30 fps source at speed 1
 * rendered at 60 fps) each source frame is shown an exact whole number of times.
 */
export function clipSourceFrameAt(
  loop: ClipLoopConfig,
  ctx: ClipTimeCtx,
  beat: number,
  fps: number,
  frameCount: number,
): number | null {
  const vt = clipSourceTimeAt(loop, ctx, beat);
  if (vt === null) return null;
  const f = Math.floor(vt * fps);
  return Math.min(frameCount - 1, Math.max(0, f));
}
