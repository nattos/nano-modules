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
import { RANDOM_DEFAULTS } from '../model/composition';

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
  /** Per-clip noise seed for `random` mode (decorrelates clips). Use {@link clipNoiseSeed}
   *  from the clip id. Ignored by every other mode; defaults to 0. */
  seed?: number;
}

const EPS = 1e-9;

const mod = (x: number, m: number) => ((x % m) + m) % m;
/** Triangle wave: 0 at 0, `period` at `period`, back to 0 at 2·period. */
const tri = (x: number, period: number) => {
  const m = mod(x, 2 * period);
  return period - Math.abs(m - period);
};

/**
 * Smooth, deterministic, seeded noise in [0,1] — a sum of sines, so it is C∞-continuous,
 * bounded, and recurrent (quasi-periodic). Used to APPROXIMATE stochastic `random` play
 * mode with a reproducible wander: the same function drives playback AND the film strips,
 * so they agree and scrubbing is repeatable. `seed` (∈[0,1)) decorrelates clips.
 */
const smoothNoise = (t: number, seed: number): number => {
  const p = seed * 6.2831853; // seed → a phase offset, spread differently per term
  const s =
    Math.sin(t + p) +
    0.6 * Math.sin(t * 1.7 + p * 2.3 + 1.1) +
    0.35 * Math.sin(t * 2.9 + p * 4.1 + 2.3);
  return 0.5 + (0.5 * s) / (1 + 0.6 + 0.35); // ∈ [0,1]
};

/** Stable per-clip noise seed (∈[0,1)) from its id, so each `random` clip wanders distinctly. */
export function clipNoiseSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 10007) / 10007;
}

/**
 * Map a play-START position into the looping source SLICE [loopStart, loopEnd].
 *
 * `playStart` is where the clip's left edge begins (Ableton's "Start" marker) — it
 * may sit BEFORE `loopStart` (a pre-roll that plays linearly until it first reaches
 * the loop, then loops) or partway inside the loop. `consumed` is the (unsigned)
 * source-seconds of playback since the left edge; `dirSign` is the play direction.
 * This decouples the loop phase from the clip's timeline start, so trimming the left
 * edge (which adjusts `playStart`) leaves the loop boundaries fixed on the timeline.
 */
function loopedSourceTime(
  playStart: number,
  consumed: number,
  loopStart: number,
  loopEnd: number,
  pingpong: boolean,
  dirSign: number,
): number {
  const loopLen = loopEnd - loopStart;
  if (loopLen <= EPS) return loopStart;
  if (dirSign >= 0) {
    const p = playStart + consumed; // tape advances up from the play-start
    if (p < loopEnd) return p; // first pass: pre-roll + up to the loop end
    const over = p - loopEnd;
    return pingpong ? loopEnd - tri(over, loopLen) : loopStart + mod(over, loopLen);
  }
  const p = playStart - consumed; // reverse: tape descends from the play-start
  if (p > loopStart) return p;
  const over = loopStart - p;
  return pingpong ? loopStart + tri(over, loopLen) : loopEnd - mod(over, loopLen);
}

/**
 * The source time (seconds into the file) to display at arrangement `beat`, or `null`
 * to render transparent. `random` is approximated by a deterministic seeded smooth-noise
 * wander over the slice (so the strips can show it + scrubbing is reproducible).
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

  if (loop.mode === 'random') {
    // STRIP/preview approximation of the stochastic dwell-jump playback (the real
    // algorithm lives in the compositor): a smooth seeded noise of the timeline beat
    // wandering the slice [startSec, endSec], its evolution rate ≈ the jump rate (1 per
    // dwell). Deterministic ⇒ the strips are drawable and scrubbing is reproducible.
    const lo = startSec;
    const hi = loop.endSec ?? ctx.videoDurSec;
    const range = hi - lo;
    if (range <= EPS) return lo;
    const secPerBeat = Math.max(1e-3, ctx.secondsAt(ctx.startBeat + 1) - ctx.secondsAt(ctx.startBeat));
    const dwellBeats = Math.max(0.05, loop.dwellUnit === 'sec'
      ? (loop.dwell ?? RANDOM_DEFAULTS.dwell) / secPerBeat
      : (loop.dwell ?? RANDOM_DEFAULTS.dwell));
    const vt = lo + range * smoothNoise(beat / dwellBeats, ctx.seed ?? 0);
    if (vt < -EPS || vt >= ctx.videoDurSec - EPS) return null;
    return vt;
  }

  // Looping modes (time / beat-sync) share one slice + play-start anchor; they differ
  // only in how fast the source is consumed per beat.
  const loopStart = startSec;
  const loopEnd = loop.endSec ?? ctx.videoDurSec;
  const loopLen = loopEnd - loopStart;
  if (loopLen <= EPS) return loopStart;
  const playStart = loop.playStartSec ?? loopStart;
  const pingpong = loop.pingpong ?? false;

  let consumed: number; // unsigned source-seconds consumed since the clip's left edge
  if (loop.mode === 'beat-sync') {
    // Loop locked to beats (BPM-independent): one loop spans `videoBeats` beats.
    const videoBeats = loop.syncUseBpm
      ? loopLen * ((loop.syncBpm ?? 120) / 60)
      : loop.syncBeats ?? 4;
    if (videoBeats <= EPS) return loopStart;
    consumed = ((beat - ctx.startBeat) / videoBeats) * loopLen;
  } else {
    // 'time': consumed at the real-time rate.
    consumed = speed * elapsedSec;
  }

  const vt = loopedSourceTime(playStart, consumed, loopStart, loopEnd, pingpong, dir);
  // A play-start before the loop can pre-roll off the file ends → transparent.
  if (vt < -EPS || vt >= ctx.videoDurSec - EPS) return null;
  return vt;
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
