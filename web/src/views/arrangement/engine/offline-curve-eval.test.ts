import { describe, it, expect } from 'vitest';
import { assembleRailCurve, railMeanAt, type WriterSpec } from './offline-curve-eval';

const beats = (n: number, lo = 0, hi = 16) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = lo + (hi - lo) * (i / (n - 1));
  return a;
};
const writer = (o: Partial<WriterSpec> = {}): WriterSpec => ({
  seed: 7, stochastic: false, combine: 'add', scale: 1, startBeat: 0, endBeat: 16, ...o,
});
const flatBase = [{ x: 0, y: 0.2 }, { x: 1, y: 0.2 }];

describe('assembleRailCurve', () => {
  it('a writer-less rail is just the base curve, with a zero-width band', () => {
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, writers: [], beats: beats(8) });
    for (let i = 0; i < c.mean.length; i++) {
      expect(c.mean[i]).toBeCloseTo(0.2, 5);
      expect(c.lo[i]).toBeCloseTo(c.mean[i], 5); // deterministic ⇒ no band
      expect(c.hi[i]).toBeCloseTo(c.mean[i], 5);
    }
  });

  it('is deterministic — same spec ⇒ identical samples', () => {
    const spec = { baseCurve: flatBase, totalBeats: 16, writers: [writer()], beats: beats(32) };
    const a = assembleRailCurve({ ...spec, beats: beats(32) });
    const b = assembleRailCurve({ ...spec, beats: beats(32) });
    expect(Array.from(a.mean)).toEqual(Array.from(b.mean));
    expect(Array.from(a.hi)).toEqual(Array.from(b.hi));
  });

  it('a deterministic writer keeps lo == hi (no error band)', () => {
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, writers: [writer({ stochastic: false })], beats: beats(24) });
    for (let i = 0; i < c.mean.length; i++) expect(c.hi[i] - c.lo[i]).toBeCloseTo(0, 5);
  });

  it('a stochastic writer widens the band (hi > lo) somewhere in its span', () => {
    const c = assembleRailCurve({ baseCurve: flatBase, totalBeats: 16, writers: [writer({ stochastic: true })], beats: beats(48) });
    let widened = false;
    for (let i = 0; i < c.mean.length; i++) if (c.hi[i] - c.lo[i] > 0.01) { widened = true; break; }
    expect(widened).toBe(true);
  });

  it('a writer only contributes within its active span (outside ⇒ base)', () => {
    const c = assembleRailCurve({
      baseCurve: flatBase, totalBeats: 16, writers: [writer({ startBeat: 4, endBeat: 8 })], beats: beats(2, 12, 14),
    });
    // Samples at beats 12..14 are outside [4,8] → pure base.
    for (let i = 0; i < c.mean.length; i++) expect(c.mean[i]).toBeCloseTo(0.2, 5);
  });

  it('two `add` writers sum onto the base at the same beat', () => {
    const at = (writers: WriterSpec[]) =>
      railMeanAt({ baseCurve: flatBase, totalBeats: 16, writers }, 5);
    const base = at([]);
    const one = at([writer()]);
    const two = at([writer(), writer({ seed: 99 })]);
    expect(one).toBeGreaterThan(base);
    expect(two).toBeGreaterThan(one); // a second add-writer raises the mean further
  });
});
