/**
 * offline-curve-eval.ts — pure, deterministic offline evaluation of a return
 * rail's value curve over a beat range. Runs in the offline-eval worker (off the
 * main + composition threads); this module holds the math so it's unit-testable.
 *
 * THE CONCEPT (forward-looking): an effect that declares an offline-evaluable
 * capability will be able to return an entire BLOCK of its modulation output for a
 * requested time range, deterministically and on demand. We structure the curve
 * rendering around that block API now and stub the per-writer block here.
 *
 * VISUALISATION ONLY. Stochastic generators can't return one exact value per beat,
 * so a block is a {mean, lo, hi} per sample — deterministic writers collapse to
 * lo == hi == mean; stochastic ones carry an "error-bar" band (the possible range).
 * The rail folds writers into a mean line + a min/max band the lane draws.
 */

import type { EnvelopePoint } from '../model/composition';
import { evalCurveAt } from './automation-eval';

export type RailCombine = 'replace' | 'mix' | 'add' | 'mul';

/** One writer (a clip's export) contributing to a rail. */
export interface WriterSpec {
  /** Stable identity hash → deterministic stub output (a real eval keys on the
   *  effect + its state instead). */
  seed: number;
  /** Declares the offline-evaluable capability as STOCHASTIC: the block is a range
   *  band, not a point (random/sample-hold/noise generators). */
  stochastic: boolean;
  combine: RailCombine;
  scale: number;
  /** Active beat span — the writer only contributes while its clip plays. */
  startBeat: number;
  endBeat: number;
}

export interface RailCurveSpec {
  baseCurve: EnvelopePoint[];
  totalBeats: number;
  writers: WriterSpec[];
  /** Sample beats (already warp-mapped by the caller — the worker stays grid-free). */
  beats: Float32Array;
}

/** Sampled rail curve: the mean line + a [lo,hi] uncertainty band per sample. */
export interface RailCurve {
  mean: Float32Array;
  lo: Float32Array;
  hi: Float32Array;
}

/** A writer's block sample: a value + its possible range (lo==hi when deterministic). */
interface Block { mean: number; lo: number; hi: number }

/** Smooth, bounded, deterministic helper (no Math.random — must be reproducible). */
function osc(beat: number, seed: number, rate: number): number {
  return Math.sin(beat * rate + seed * 1.7) * 0.5 + 0.5; // [0,1]
}

/**
 * Pretend per-writer block: the writer's modulation output at `beat`. Deterministic
 * by (seed, beat). Stochastic writers return a band (mean ± a time-varying spread);
 * deterministic ones a point. A gentle fade at the clip edges keeps contributions
 * reading as "layered on". Replaced later by the effect's real offline block.
 */
function writerBlockAt(w: WriterSpec, beat: number): Block | null {
  if (beat < w.startBeat || beat > w.endBeat) return null; // inactive → no contribution
  const span = Math.max(1e-3, w.endBeat - w.startBeat);
  const t = (beat - w.startBeat) / span;
  const fade = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI); // 0→1→0 across the clip
  const s = w.scale;
  if (!w.stochastic) {
    const v = (0.15 + 0.7 * osc(beat, w.seed, 0.7)) * fade * s;
    return { mean: v, lo: v, hi: v };
  }
  // Stochastic: a wandering centre with a time-varying spread → an error-bar band.
  const centre = (0.2 + 0.6 * osc(beat, w.seed, 0.31)) * fade;
  const spread = (0.12 + 0.18 * osc(beat, w.seed * 2 + 9, 0.13)) * fade;
  return { mean: centre * s, lo: Math.max(0, centre - spread) * s, hi: (centre + spread) * s };
}

function fold(acc: number, v: number, combine: RailCombine): number {
  switch (combine) {
    case 'add': return acc + v;
    case 'mul': return acc * v;
    case 'replace': return v;
    case 'mix': return (acc + v) * 0.5;
    default: return acc + v;
  }
}

/**
 * Assemble the rail's value curve over `spec.beats`: the base curve seeds each of the
 * mean / lo / hi accumulators, then every ACTIVE writer folds in per its combine. The
 * band [lo,hi] widens only where a stochastic writer contributes; everywhere else
 * lo == hi == mean.
 */
export function assembleRailCurve(spec: RailCurveSpec): RailCurve {
  const n = spec.beats.length;
  const mean = new Float32Array(n);
  const lo = new Float32Array(n);
  const hi = new Float32Array(n);
  const T = Math.max(1e-6, spec.totalBeats);
  for (let i = 0; i < n; i++) {
    const beat = spec.beats[i];
    const base = evalCurveAt(spec.baseCurve, beat / T);
    let m = base, l = base, h = base;
    for (const w of spec.writers) {
      const b = writerBlockAt(w, beat);
      if (!b) continue;
      m = fold(m, b.mean, w.combine);
      // Interval fold (approximate for non-add combines): keep the bounds ordered.
      const a = fold(l, b.lo, w.combine);
      const c = fold(h, b.hi, w.combine);
      l = Math.min(a, c);
      h = Math.max(a, c);
    }
    mean[i] = m; lo[i] = l; hi[i] = h;
  }
  return { mean, lo, hi };
}

/** Sample the assembled mean at a single beat (the live playhead dot — cheap, no
 *  worker round-trip). Mirrors assembleRailCurve's fold for one point. */
export function railMeanAt(spec: Omit<RailCurveSpec, 'beats'>, beat: number): number {
  const base = evalCurveAt(spec.baseCurve, beat / Math.max(1e-6, spec.totalBeats));
  let m = base;
  for (const w of spec.writers) {
    const b = writerBlockAt(w, beat);
    if (b) m = fold(m, b.mean, w.combine);
  }
  return m;
}
