/**
 * Read-ahead policy — which frames to pre-cache after a pull, given the
 * current access mode. Pure logic (no state, no GPU, no browser deps) so
 * it's unit-testable in isolation and importable from a node test env.
 */

import type { AccessMode } from './access-classifier';

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
