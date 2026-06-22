/**
 * WarpClock — the offline beat⇄seconds map under warp (Innovation 1 / PRD M3).
 *
 * The visual grid already integrates the tempo multiplier into "warped units"
 * (`WarpCurve` in model/beat-grid.ts). The seek clock is the SAME integral
 * scaled by the base seconds-per-beat, so the grid render and playback seeking
 * share one source of truth:
 *
 *     secondsAt(beat) = (60 / bpm) · unitsAt(beat)
 *
 * Semantic: warped units are beats measured in stretched time. Where the grid
 * SPREADS (tempo multiplier m>1, more units/beat) more real time is spent — that
 * region plays slower; where it CLUMPS (m<1) it plays faster. Because each warp
 * wave averages ~0 over its period, units ≈ beats on average, so a warp doesn't
 * change the overall duration — it only redistributes time within.
 *
 * Fully offline/precomputed (a cumulative table), so the whole timeline can be
 * resolved without stepping the live playhead — the hard requirement for
 * seeking and offline render. Pure; no engine/worker/GPU dependency.
 */

import { WarpCurve } from '../model/beat-grid';
import {
  derivedWarpSegments,
  compositionLengthBeats,
  type Composition,
} from '../model/composition';

/** Build the offline warp curve for a composition (its warp bindings + extent). */
export function precomputeWarp(comp: Composition): WarpCurve {
  return new WarpCurve(derivedWarpSegments(comp), compositionLengthBeats(comp));
}

export class WarpClock {
  /** Base seconds per beat at the nominal tempo (no warp). */
  readonly secondsPerBeat: number;

  constructor(readonly curve: WarpCurve, bpm: number) {
    this.secondsPerBeat = 60 / bpm;
  }

  /** Real seconds elapsed from beat 0 to `beat`, accounting for warp. */
  secondsAt(beat: number): number {
    return this.secondsPerBeat * this.curve.unitsAt(beat);
  }

  /** Inverse: the (warped) beat playing at `seconds`. */
  beatAtSeconds(seconds: number): number {
    return this.curve.beatAt(seconds / this.secondsPerBeat);
  }

  /**
   * Instantaneous seconds-per-beat at `beat` (local stretch): > base where the
   * grid spreads (slower), < base where it clumps (faster). Central difference.
   */
  localSecondsPerBeat(beat: number, eps = 1e-3): number {
    const lo = Math.max(0, beat - eps);
    const hi = beat + eps;
    return (this.secondsAt(hi) - this.secondsAt(lo)) / (hi - lo);
  }

  /** Total composition duration in seconds (warp-aware). */
  get durationSeconds(): number {
    return this.secondsAt(this.curve.totalBeats);
  }
}

/** Convenience: precompute the warp curve + clock for a composition. */
export function makeWarpClock(comp: Composition): WarpClock {
  return new WarpClock(precomputeWarp(comp), comp.meta.baseBPM);
}
