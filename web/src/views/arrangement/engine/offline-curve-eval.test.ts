import { describe, it, expect } from 'vitest';
import { assembleRailCurve, railMeanAt, type WriterSpec, type LfoParams, type RailCombine } from './offline-curve-eval';

const beats = (n: number, lo = 0, hi = 16) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = lo + (hi - lo) * (i / (n - 1));
  return a;
};
const writer = (o: Partial<WriterSpec> = {}): WriterSpec => ({
  seed: 7, stochastic: false, combine: 'add', scale: 1, startBeat: 0, endBeat: 16, ...o,
});
const lfo = (o: Partial<LfoParams> = {}): LfoParams => ({
  mode: 0, rate: 0.5, period: 1, amplitude: 1, waveform: 0, shape: 0, invert: false, ...o,
});
const flatBase = [{ x: 0, y: 0.2 }, { x: 1, y: 0.2 }];
const SPB = 0.5; // 120 bpm

describe('assembleRailCurve', () => {
  it('a writer-less rail is just the base curve, with a zero-width band', () => {
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers: [], beats: beats(8) });
    for (let i = 0; i < c.mean.length; i++) {
      expect(c.mean[i]).toBeCloseTo(0.2, 5);
      expect(c.lo[i]).toBeCloseTo(c.mean[i], 5); // deterministic ⇒ no band
      expect(c.hi[i]).toBeCloseTo(c.mean[i], 5);
    }
  });

  it('is deterministic — same spec ⇒ identical samples', () => {
    const spec = { baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers: [writer()], beats: beats(32) };
    const a = assembleRailCurve({ ...spec, beats: beats(32) });
    const b = assembleRailCurve({ ...spec, beats: beats(32) });
    expect(Array.from(a.mean)).toEqual(Array.from(b.mean));
    expect(Array.from(a.hi)).toEqual(Array.from(b.hi));
  });

  it('a deterministic writer keeps lo == hi (no error band)', () => {
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers: [writer({ stochastic: false })], beats: beats(24) });
    for (let i = 0; i < c.mean.length; i++) expect(c.hi[i] - c.lo[i]).toBeCloseTo(0, 5);
  });

  it('a stochastic writer widens the band (hi > lo) somewhere in its span', () => {
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers: [writer({ stochastic: true })], beats: beats(48) });
    let widened = false;
    for (let i = 0; i < c.mean.length; i++) if (c.hi[i] - c.lo[i] > 0.01) { widened = true; break; }
    expect(widened).toBe(true);
  });

  it('a writer only contributes within its active span (outside ⇒ base)', () => {
    const c = assembleRailCurve({
      baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers: [writer({ startBeat: 4, endBeat: 8 })], beats: beats(2, 12, 14),
    });
    // Samples at beats 12..14 are outside [4,8] → pure base.
    for (let i = 0; i < c.mean.length; i++) expect(c.mean[i]).toBeCloseTo(0.2, 5);
  });

  it('two `add` writers sum onto the base at the same beat', () => {
    const at = (writers: WriterSpec[]) =>
      railMeanAt({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers }, 5);
    const base = at([]);
    const one = at([writer()]);
    const two = at([writer(), writer({ seed: 99 })]);
    expect(one).toBeGreaterThan(base);
    expect(two).toBeGreaterThan(one); // a second add-writer raises the mean further
  });
});

describe('LFO mirror (mod.source.lfo)', () => {
  const lw = (p: Partial<LfoParams>, combine: RailCombine = 'replace'): WriterSpec => {
    const l = lfo(p);
    return writer({ kind: 'lfo', lfo: l, combine, stochastic: l.waveform === 4 || l.waveform === 5 });
  };
  // `replace` so the result IS the LFO value (base ignored), at 120 bpm (SPB 0.5).
  const at = (w: WriterSpec, beat: number) =>
    railMeanAt({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, writers: [w] }, beat);

  it('a sine LFO sits at 0.5 at the clip start (phase 0)', () => {
    expect(at(lw({ waveform: 0 }), 0)).toBeCloseTo(0.5, 4);
  });

  it('a sine LFO reaches its peak a quarter-cycle in', () => {
    // freq = rate·10 = 5 Hz; phase = elapsed·freq = beat·SPB·5 = beat·2.5 cycles →
    // a quarter cycle (peak) at beat 0.1.
    expect(at(lw({ waveform: 0, rate: 0.5, amplitude: 1 }), 0.1)).toBeCloseTo(1.0, 3);
  });

  it('amplitude scales the swing about 0.5', () => {
    expect(at(lw({ waveform: 0, amplitude: 0.5 }), 0.1)).toBeCloseTo(0.75, 3);
  });

  it('invert flips the output (peak → trough)', () => {
    expect(at(lw({ waveform: 0, invert: true }), 0.1)).toBeCloseTo(0.0, 3);
  });

  it('Period mode derives frequency from the period (1s period → peak at 0.25s)', () => {
    // freq = 1/period = 1 Hz; 0.25 s = beat·SPB ⇒ beat 0.5 → quarter cycle → peak.
    expect(at(lw({ mode: 1, period: 1, amplitude: 1 }), 0.5)).toBeCloseTo(1.0, 3);
  });

  it('Random Walk is stochastic → a band, not a point', () => {
    const c = assembleRailCurve({
      baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB,
      writers: [lw({ waveform: 4 }, 'add')], beats: beats(8),
    });
    let widened = false;
    for (let i = 0; i < c.hi.length; i++) if (c.hi[i] - c.lo[i] > 0.05) { widened = true; break; }
    expect(widened).toBe(true);
  });
});
