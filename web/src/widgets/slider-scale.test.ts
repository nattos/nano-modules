import { describe, it, expect } from 'vitest';
import { fromTravel, roundForScale, toTravel } from './slider-scale';
import { modBandGeometry } from './scalar-slider';

describe('slider scale', () => {
  it('a log slider gives every decade the same travel', () => {
    // 0.01..100: four decades, a quarter of the travel each.
    expect(toTravel(0.01, 0.01, 100, 'log')).toBeCloseTo(0);
    expect(toTravel(0.1, 0.01, 100, 'log')).toBeCloseTo(0.25);
    expect(toTravel(1, 0.01, 100, 'log')).toBeCloseTo(0.5);
    expect(toTravel(100, 0.01, 100, 'log')).toBeCloseTo(1);
    expect(fromTravel(0.5, 0.01, 100, 'log')).toBeCloseTo(1);
  });

  it('round-trips, and a value below min sits at the start of the travel', () => {
    for (const v of [0.02, 0.5, 5, 60, 120]) {
      expect(fromTravel(toTravel(v, 0.01, 120, 'log'), 0.01, 120, 'log')).toBeCloseTo(v, 6);
    }
    expect(toTravel(0, 0.01, 120, 'log')).toBe(0);   // a stopped LFO
  });

  it('falls back to linear when the range cannot be logarithmic', () => {
    expect(toTravel(0.5, 0, 1, 'log')).toBeCloseTo(0.5);
    expect(fromTravel(0.25, -1, 1, 'log')).toBeCloseTo(-0.5);
  });

  it('rounds a log value to three significant figures, a linear one to its step', () => {
    expect(roundForScale(0.012345, 0.01, 'log')).toBeCloseTo(0.0123, 6);
    expect(roundForScale(45.678, 0.01, 'log')).toBeCloseTo(45.7, 6);
    expect(roundForScale(0.12345, 0.01, 'linear')).toBeCloseTo(0.12, 6);
  });

  it('the modulation band lands where the log slider would put the values', () => {
    const g = modBandGeometry(0.01, 100, { value: 1, min: 0.1, max: 10, neutral: 1 }, 'log');
    expect(g.lo).toBeCloseTo(25);
    expect(g.hi).toBeCloseTo(75);
    expect(g.fillLo).toBeCloseTo(50);
  });
});
