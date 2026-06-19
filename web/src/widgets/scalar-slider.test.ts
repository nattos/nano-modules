import { describe, it, expect } from 'vitest';
import { modBandGeometry } from './scalar-slider';

// modBandGeometry maps a modulation band {value,min,max} (field units) into the
// slider's [min,max] as 0..100 percentages — the geometry the .mod-band strip
// and .mod-tick marker are positioned with.
describe('modBandGeometry', () => {
  it('maps a centered sub-range to its proportional band + tick', () => {
    const g = modBandGeometry(0, 1, { value: 0.5, min: 0.25, max: 0.75 });
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
    expect(g.width).toBeCloseTo(50);
    expect(g.tick).toBeCloseTo(50);
  });

  it('spans the full slider when the band equals [min,max]', () => {
    const g = modBandGeometry(0, 1, { value: 0.5, min: 0, max: 1 });
    expect(g.lo).toBeCloseTo(0);
    expect(g.hi).toBeCloseTo(100);
    expect(g.width).toBeCloseTo(100);
  });

  it('respects a non-[0,1] slider range', () => {
    // slider [-1,1]; band [-0.5, 0.5] → 25%..75%, value 0 → 50%.
    const g = modBandGeometry(-1, 1, { value: 0, min: -0.5, max: 0.5 });
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
    expect(g.tick).toBeCloseTo(50);
  });

  it('clamps a band that exceeds the slider range to [0,100]', () => {
    const g = modBandGeometry(0, 1, { value: 2, min: -1, max: 3 });
    expect(g.lo).toBe(0);
    expect(g.hi).toBe(100);
    expect(g.width).toBe(100);
    expect(g.tick).toBe(100);
  });

  it('normalizes regardless of min/max order on the band', () => {
    const g = modBandGeometry(0, 1, { value: 0.5, min: 0.75, max: 0.25 });
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
  });

  it('degrades to a zero band when the slider range is unbounded', () => {
    const g = modBandGeometry(0, Infinity, { value: 5, min: 0, max: 10 });
    expect(g.lo).toBe(0);
    expect(g.hi).toBe(0);
    expect(g.width).toBe(0);
    expect(g.tick).toBe(0);
  });
});
