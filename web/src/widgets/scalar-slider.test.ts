import { describe, it, expect } from 'vitest';
import { modBandGeometry } from './scalar-slider';

// modBandGeometry maps a modulation band {value,min,max,neutral} (field units)
// into the slider's [min,max] as 0..100 percentages: the dim full-range .mod-band
// (lo..hi) and the bright .mod-fill that spans neutral→value.
describe('modBandGeometry', () => {
  it('maps the full band and fills from neutral up to the value', () => {
    // band [0.25,0.75] → 25..75; fill from neutral 0.3 (30%) to value 0.6 (60%).
    const g = modBandGeometry(0, 1, { value: 0.6, min: 0.25, max: 0.75, neutral: 0.3 });
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
    expect(g.width).toBeCloseTo(50);
    expect(g.fillLo).toBeCloseTo(30);
    expect(g.fillWidth).toBeCloseTo(30);
  });

  it('fills downward when the value is below neutral (add modulating negative)', () => {
    // neutral 0.5 (50%), value 0.2 (20%) → fill from 20% width 30%.
    const g = modBandGeometry(0, 1, { value: 0.2, min: 0.0, max: 1.0, neutral: 0.5 });
    expect(g.fillLo).toBeCloseTo(20);
    expect(g.fillWidth).toBeCloseTo(30);
  });

  it('mul fills from zero (neutral 0)', () => {
    const g = modBandGeometry(0, 1, { value: 0.7, min: 0, max: 0.7, neutral: 0 });
    expect(g.fillLo).toBeCloseTo(0);
    expect(g.fillWidth).toBeCloseTo(70);
  });

  it('spans the full slider when the band equals [min,max]', () => {
    const g = modBandGeometry(0, 1, { value: 0.5, min: 0, max: 1, neutral: 0 });
    expect(g.lo).toBeCloseTo(0);
    expect(g.hi).toBeCloseTo(100);
    expect(g.width).toBeCloseTo(100);
  });

  it('respects a non-[0,1] slider range', () => {
    // slider [-1,1]; band [-0.5,0.5] → 25..75; neutral 0 (50%), value 0.5 (75%).
    const g = modBandGeometry(-1, 1, { value: 0.5, min: -0.5, max: 0.5, neutral: 0 });
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
    expect(g.fillLo).toBeCloseTo(50);
    expect(g.fillWidth).toBeCloseTo(25);
  });

  it('clamps band + fill that exceed the slider range to [0,100]', () => {
    const g = modBandGeometry(0, 1, { value: 2, min: -1, max: 3, neutral: -1 });
    expect(g.lo).toBe(0);
    expect(g.hi).toBe(100);
    expect(g.width).toBe(100);
    expect(g.fillLo).toBe(0);
    expect(g.fillWidth).toBe(100);
  });

  it('normalizes regardless of min/max order on the band', () => {
    const g = modBandGeometry(0, 1, { value: 0.5, min: 0.75, max: 0.25, neutral: 0.5 });
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
  });

  it('falls back to a zero-width fill when neutral is absent', () => {
    const g = modBandGeometry(0, 1, { value: 0.6, min: 0, max: 1 });
    expect(g.fillWidth).toBeCloseTo(0);
    expect(g.fillLo).toBeCloseTo(60);
  });

  it('degrades to a zero band when the slider range is unbounded', () => {
    const g = modBandGeometry(0, Infinity, { value: 5, min: 0, max: 10, neutral: 0 });
    expect(g.lo).toBe(0);
    expect(g.hi).toBe(0);
    expect(g.width).toBe(0);
    expect(g.fillWidth).toBe(0);
  });
});
