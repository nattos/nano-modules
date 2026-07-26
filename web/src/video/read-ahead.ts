/**
 * Read-ahead policy — which frames to pre-cache after a pull, and which to pin,
 * given the current access mode. Pure logic (no state, no GPU, no browser deps)
 * so it's unit-testable in isolation and importable from a node test env.
 *
 * LOCK-STEP: native/src/media/read_ahead.h (shared goldens:
 * video-policy-goldens.test.ts ↔ native/tests/test_video_policy.cpp). The
 * precache depth and hit rate a perf run measures only mean anything if both
 * hosts pick the same frames.
 */

import type { AccessMode, ClassifierSnapshot } from './access-classifier';

/** Per-pull read-ahead depth for ring-shaped modes (Sequential / Reverse
 *  / Strided). Sized to roughly cover the gap between consecutive pulls
 *  on a 30 fps timeline. */
export const READAHEAD_DEPTH = 5;

export interface ReadAheadInputs {
  mode: AccessMode;
  frameIdx: number;
  frameCount: number;
  /** Sign of the most recent non-zero motion (+1 forward, −1 backward). */
  motionDir: number;
  depth: number;
  /** Detected stride for the Strided mode (signed). */
  stride?: number;
}

/**
 * Sequential and Reverse both pre-cache in the ACTUAL direction of motion
 * (`motionDir`), not the mode's nominal direction. For a steady run the
 * two agree; for an oscillating pattern (ping-pong, LFO) the classified
 * mode lags each turn, so following the live direction keeps the
 * read-ahead ahead of the playhead through every reversal.
 */
export function computeReadAheadTargets(inp: ReadAheadInputs): number[] {
  const { mode, frameIdx, frameCount, motionDir, depth } = inp;
  const clamp = (i: number) => i >= 0 && i < frameCount;
  switch (mode) {
    case 'Sequential':
    case 'Reverse': {
      const dir = motionDir < 0 ? -1 : 1;
      const out: number[] = [];
      for (let k = 1; k <= depth; k++) {
        const t = frameIdx + k * dir;
        if (clamp(t)) out.push(t);
      }
      return out;
    }
    case 'Strided': {
      const stride = inp.stride ?? 1;
      const out: number[] = [];
      for (let k = 1; k <= depth; k++) {
        const t = frameIdx + k * stride;
        if (clamp(t)) out.push(t);
      }
      return out;
    }
    case 'Loop':
      // Loop pinning covers the range; light read-ahead for the next one.
      return clamp(frameIdx + 1) ? [frameIdx + 1] : [];
    case 'Scrub':
      return [frameIdx - 1, frameIdx + 1].filter(clamp);
    case 'Hotspots':
    case 'Random':
    default:
      return [];
  }
}

/**
 * Which frames the cache should PIN (hold against LRU eviction) for the current
 * access mode: a Loop's whole range, or the detected hot frames. Every other
 * mode pins nothing and rides read-ahead alone.
 */
export function computePinnedFrames(snap: ClassifierSnapshot): number[] {
  if (snap.mode === 'Loop' && snap.loopRange) {
    const [a, b] = snap.loopRange;
    const out: number[] = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  if (snap.mode === 'Hotspots' && snap.hotFrames) return snap.hotFrames.slice();
  return [];
}
