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

/** `mod.source.lfo` instance parameters — a TypeScript mirror of the native LFO
 *  (env_lfo/main.cpp), so its writer block is an APPROXIMATE-but-real curve rather
 *  than a generic stub. Random Walk / Random FM are stochastic (a band, not a line). */
export interface LfoParams {
  mode: number;       // 0 = Freq, 1 = Period
  rate: number;       // [0,1] → 0..10 Hz (Freq mode)
  period: number;     // seconds (Period mode); freq = 1/period
  amplitude: number;  // [0,1] swing around 0.5
  waveform: number;   // 0 Sine · 1 Square · 2 Triangle · 3 Saw · 4 RandomWalk · 5 RandomFM
  shape: number;      // [0,1] morph
  invert: boolean;
}

/** One writer (a clip's export) contributing to a rail. */
export interface WriterSpec {
  /** Stable identity hash → deterministic stub output (used by the generic kind). */
  seed: number;
  /** STOCHASTIC capability: the block is a range band, not a point. */
  stochastic: boolean;
  combine: RailCombine;
  scale: number;
  /** Active beat span — the writer only contributes while its clip plays. */
  startBeat: number;
  endBeat: number;
  /** Which offline mirror to use. `'lfo'` carries `lfo`; anything else → the generic
   *  seeded stub until that effect gets its own mirror. */
  kind?: 'lfo' | 'generic';
  lfo?: LfoParams;
}

export interface RailCurveSpec {
  baseCurve: EnvelopePoint[];
  totalBeats: number;
  writers: WriterSpec[];
  /** Beats→seconds for time-based mirrors (LFO). Approximate: 60/bpm, warp ignored. */
  secondsPerBeat: number;
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

/** Mirror of env_lfo `deterministicWave`: f(phase∈[0,1)) → [-1,1], morphed by shape. */
function lfoWave(wf: number, shape: number, p: number): number {
  const s = Math.max(0, Math.min(1, shape));
  switch (wf) {
    case 1: { // Square — `shape` narrows the duty 0.5 → 0.05
      const duty = 0.5 - 0.45 * s;
      return p < duty ? 1 : -1;
    }
    case 2: { // Triangle — tilt the peak toward the end
      const peak = 0.5 + 0.49 * s;
      const tri = p < peak ? p / peak : (1 - p) / (1 - peak);
      return tri * 2 - 1;
    }
    case 3: { // Saw — `shape` bows the ramp (exp ease)
      const e = Math.pow(2, s * 3);
      return Math.pow(p, e) * 2 - 1;
    }
    default: { // Sine → soft-clipped sine
      const sinv = Math.sin(p * Math.PI * 2);
      const drive = 1 + 7 * s;
      const clipped = Math.tanh(drive * sinv) / Math.tanh(drive);
      return sinv + (clipped - sinv) * s;
    }
  }
}

/** Approximate-but-real LFO block: phase = elapsedSec·freq from the clip start (the
 *  LFO begins when its clip becomes active). Deterministic waveforms → a point;
 *  Random Walk/FM → the swing band (the exact random path can't be reproduced). */
function lfoBlockAt(w: WriterSpec, secPerBeat: number, beat: number): Block {
  const p = w.lfo!;
  const amp = Math.max(0, Math.min(1, p.amplitude));
  const flip = (v: number) => (p.invert ? 1 - v : v);
  // Random Walk (4) / Random FM (5): output wanders the full amplitude swing.
  if (p.waveform === 4 || p.waveform === 5) {
    const a = flip(0.5 - amp * 0.5) * w.scale;
    const b = flip(0.5 + amp * 0.5) * w.scale;
    return { mean: flip(0.5) * w.scale, lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  const freq = p.mode === 1 ? 1 / Math.max(0.01, p.period) : p.rate * 10; // Hz
  const elapsed = (beat - w.startBeat) * secPerBeat; // seconds since clip start
  let phase = elapsed * freq;
  phase -= Math.floor(phase);
  let v = lfoWave(p.waveform, p.shape, phase) * amp * 0.5 + 0.5;
  v = flip(Math.max(0, Math.min(1, v))) * w.scale;
  return { mean: v, lo: v, hi: v };
}

/**
 * Per-writer block at `beat`. `mod.source.lfo` uses its real (mirrored) math from the
 * transferred instance params. Every OTHER (un-mirrored) effect is an UNKNOWN
 * modulator: we can't predict its output, so rather than draw a confident — and
 * wrong — line, it renders an uncertainty band spanning its full possible swing,
 * ballooning over the clip span (pinched to a neutral centre at the edges, the whole
 * [0,1] at the middle). A faint wander on the centre keeps it from reading as a fixed
 * value. Returns null outside the writer's active span.
 */
function writerBlockAt(w: WriterSpec, secPerBeat: number, beat: number): Block | null {
  if (beat < w.startBeat || beat > w.endBeat) return null; // inactive → no contribution
  if (w.kind === 'lfo' && w.lfo) return lfoBlockAt(w, secPerBeat, beat);
  const span = Math.max(1e-3, w.endBeat - w.startBeat);
  const fade = Math.sin(Math.min(1, Math.max(0, (beat - w.startBeat) / span)) * Math.PI);
  const s = w.scale;
  const centre = 0.5 + (osc(beat, w.seed, 0.5) - 0.5) * 0.25 * fade; // gentle wander near 0.5
  const half = 0.5 * fade; // balloon to the full [0,1] swing at the clip centre
  return { mean: centre * s, lo: Math.max(0, centre - half) * s, hi: Math.min(1, centre + half) * s };
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
      const b = writerBlockAt(w, spec.secondsPerBeat, beat);
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
    const b = writerBlockAt(w, spec.secondsPerBeat, beat);
    if (b) m = fold(m, b.mean, w.combine);
  }
  return m;
}
