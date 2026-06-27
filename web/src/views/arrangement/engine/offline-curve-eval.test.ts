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
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false, writers: [], beats: beats(8) });
    for (let i = 0; i < c.mean.length; i++) {
      expect(c.mean[i]).toBeCloseTo(0.2, 5);
      expect(c.lo[i]).toBeCloseTo(c.mean[i], 5); // deterministic ⇒ no band
      expect(c.hi[i]).toBeCloseTo(c.mean[i], 5);
    }
  });

  it('is deterministic — same spec ⇒ identical samples', () => {
    const spec = { baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false, writers: [writer()], beats: beats(32) };
    const a = assembleRailCurve({ ...spec, beats: beats(32) });
    const b = assembleRailCurve({ ...spec, beats: beats(32) });
    expect(Array.from(a.mean)).toEqual(Array.from(b.mean));
    expect(Array.from(a.hi)).toEqual(Array.from(b.hi));
  });

  it('peak envelope anti-aliases: a fast signed LFO bands to ~full swing (max-magnitude line); a slow one stays tight', () => {
    const zeroBase = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    const mk = (rate: number) => assembleRailCurve({
      baseCurve: zeroBase, totalBeats: 16, secondsPerBeat: SPB, signed: true,
      // Span well beyond the sampled range so no bucket straddles the on/off edge —
      // isolating the frequency-aliasing property the peak envelope fixes.
      writers: [writer({ kind: 'lfo', sourceSigned: true, startBeat: -1000, endBeat: 1000, lfo: lfo({ rate, amplitude: 1 }) })],
      beats: beats(12), // coarse: each bucket spans many cycles for a fast LFO
    });
    const stats = (c: ReturnType<typeof mk>) => {
      let band = 0, peak = 0;
      for (let i = 0; i < c.mean.length; i++) { band = Math.max(band, c.hi[i] - c.lo[i]); peak = Math.max(peak, Math.abs(c.mean[i])); }
      return { band, peak };
    };
    const fast = stats(mk(1));      // 10 Hz → many cycles per bucket
    const slow = stats(mk(0.005));  // 0.05 Hz → ≪ one cycle per bucket
    expect(fast.band).toBeGreaterThan(1.5);            // ~full ±1 peak-to-peak (instead of aliasing)
    expect(fast.peak).toBeGreaterThan(0.8);            // the line hugs the swing, not DC ≈ 0
    expect(slow.band).toBeLessThan(0.6);               // a slow signal stays a tight line
    expect(slow.band).toBeLessThan(fast.band * 0.5);   // and is clearly tighter than the fast one
  });

  it('an UNKNOWN (un-mirrored) modulator renders an uncertainty band (hi > lo)', () => {
    // No kind ⇒ generic: we cannot predict its output, so it must show a swing band.
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false, writers: [writer()], beats: beats(48) });
    let widened = false;
    for (let i = 0; i < c.mean.length; i++) if (c.hi[i] - c.lo[i] > 0.05) { widened = true; break; }
    expect(widened).toBe(true);
  });

  it('a writer only contributes within its active span (outside ⇒ base)', () => {
    const c = assembleRailCurve({
      baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false, writers: [writer({ startBeat: 4, endBeat: 8 })], beats: beats(2, 12, 14),
    });
    // Samples at beats 12..14 are outside [4,8] → pure base.
    for (let i = 0; i < c.mean.length; i++) expect(c.mean[i]).toBeCloseTo(0.2, 5);
  });

  it('two `add` writers sum onto the base at the same beat', () => {
    const at = (writers: WriterSpec[]) =>
      railMeanAt({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false, writers }, 5);
    const base = at([]);
    const one = at([writer()]);
    const two = at([writer(), writer({ seed: 99 })]);
    expect(one).toBeGreaterThan(base);
    expect(two).toBeGreaterThan(one); // a second add-writer raises the mean further
  });

  it('the base is the rest value directly (not prescaled) in either mode', () => {
    const at = (signed: boolean) =>
      railMeanAt({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed, writers: [] }, 5);
    expect(at(false)).toBeCloseTo(0.2, 5);
    expect(at(true)).toBeCloseTo(0.2, 5); // NOT 0.2·2−1 = −0.6 — only writers prescale
  });

  it('signed mode prescales contributions to bipolar [-1,1] (0.5 output → 0)', () => {
    const sine = writer({ kind: 'lfo', sourceSigned: true, lfo: lfo({ waveform: 0 }), combine: 'replace' });
    // Bipolar sine at phase 0 = 0. Into an unsigned rail ⇒ 0.5 (centre); into a signed
    // rail ⇒ 0 (identity).
    const spec = (signed: boolean) =>
      railMeanAt({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed, writers: [sine] }, 0);
    expect(spec(false)).toBeCloseTo(0.5, 4);
    expect(spec(true)).toBeCloseTo(0, 4);
  });
});

describe('LFO mirror (mod.source.lfo)', () => {
  const lw = (p: Partial<LfoParams>, combine: RailCombine = 'replace'): WriterSpec => {
    const l = lfo(p);
    // The LFO is a SIGNED source ([-1,1]); into an unsigned rail it maps to [0,1].
    return writer({ kind: 'lfo', lfo: l, combine, sourceSigned: true, stochastic: l.waveform === 4 || l.waveform === 5 });
  };
  // `replace` so the result IS the LFO value (base ignored), at 120 bpm (SPB 0.5).
  const at = (w: WriterSpec, beat: number) =>
    railMeanAt({ baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false, writers: [w] }, beat);

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
      baseCurve: flatBase, totalBeats: 16, secondsPerBeat: SPB, signed: false,
      writers: [lw({ waveform: 4 }, 'add')], beats: beats(8),
    });
    let widened = false;
    for (let i = 0; i < c.hi.length; i++) if (c.hi[i] - c.lo[i] > 0.05) { widened = true; break; }
    expect(widened).toBe(true);
  });
});
