import { describe, it, expect } from 'vitest';
import { graphStats, imageStats, meanAbsDiff, thumbFlags } from './thumb-stats';

function solid(n: number, r: number, g: number, b: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) a.set([r, g, b, 255], i * 4);
  return a;
}

function ramp(n: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round((i / (n - 1)) * 255);
    a.set([v, 255 - v, (v * 3) & 255, 255], i * 4);
  }
  return a;
}

describe('thumb stats', () => {
  it('flags a solid frame as blank and a ramp as not', () => {
    const s = imageStats(solid(100, 40, 80, 120));
    expect(s.distinct).toBe(1);
    expect(s.std).toBeCloseTo(0, 5);
    expect(thumbFlags({ image: s })).toEqual(['blank']);
    const r = imageStats(ramp(256));
    expect(r.distinct).toBeGreaterThan(20);
    expect(thumbFlags({ image: r })).toEqual([]);
  });

  it('measures difference from the input', () => {
    const a = ramp(64);
    expect(meanAbsDiff(a, a)).toBe(0);
    expect(meanAbsDiff(a, solid(64, 0, 0, 0))).toBeGreaterThan(50);
    expect(meanAbsDiff(a, solid(8, 0, 0, 0))).toBe(Infinity);
    expect(thumbFlags({ image: imageStats(a), diffFromInput: 0.2 })).toEqual(['same-as-input']);
  });

  it('flags a flat or empty graph', () => {
    expect(graphStats([0.5, 0.5, 0.5], 0, 1).range).toBe(0);
    expect(thumbFlags({ graph: graphStats([0.5, 0.5, 0.5], 0, 1) })).toEqual(['flat']);
    expect(thumbFlags({ graph: graphStats([NaN, NaN], 0, 1) })).toEqual(['flat']);
    const g = graphStats([0, 0.5, 1, NaN], 0, 2);
    expect(g).toEqual({ finite: 3, range: 0.5 });
    expect(thumbFlags({ graph: g })).toEqual([]);
  });
});
