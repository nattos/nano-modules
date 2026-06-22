import { describe, it, expect } from 'vitest';
import { toEnvPoints, evalCurveAt, sampleCurve } from './automation-eval';
import { evalEnvelope, applyEase } from '../../../editors/envelope-math';
import type { EnvelopePoint } from '../model/composition';

describe('automation-eval', () => {
  it('maps bend → ease and sorts by x', () => {
    const pts: EnvelopePoint[] = [
      { x: 1, y: 1, bend: 0.5 },
      { x: 0, y: 0, bend: -0.25 },
    ];
    const env = toEnvPoints(pts);
    expect(env.map((p) => p.x)).toEqual([0, 1]); // sorted
    expect(env[0].ease).toBe(-0.25);
    expect(env[1].ease).toBe(0.5);
  });

  it('treats a missing bend as linear (ease 0)', () => {
    const env = toEnvPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(env.every((p) => p.ease === 0)).toBe(true);
  });

  it('evaluates linearly with no bend', () => {
    const pts: EnvelopePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(evalCurveAt(pts, 0.5)).toBeCloseTo(0.5, 6);
    expect(evalCurveAt(pts, 0.25)).toBeCloseTo(0.25, 6);
  });

  it('applies the eased shape and stays lock-step with evalEnvelope', () => {
    const pts: EnvelopePoint[] = [{ x: 0, y: 0, bend: 1 }, { x: 1, y: 1 }];
    // ease=1 → exponent 2^-3 → 0.5^0.125.
    expect(evalCurveAt(pts, 0.5)).toBeCloseTo(applyEase(0.5, 1), 6);
    // Identical to evaluating the mapped points directly through the twin.
    expect(evalCurveAt(pts, 0.7)).toBeCloseTo(evalEnvelope(toEnvPoints(pts), 0.7), 9);
  });

  it('clamps flat outside the point range; 0 for empty', () => {
    const pts: EnvelopePoint[] = [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.9 }];
    expect(evalCurveAt(pts, 0)).toBeCloseTo(0.3, 6);
    expect(evalCurveAt(pts, 1)).toBeCloseTo(0.9, 6);
    expect(evalCurveAt([], 0.5)).toBe(0);
  });

  it('samples a dense eased polyline across [0,1]', () => {
    const pts: EnvelopePoint[] = [{ x: 0, y: 0, bend: 1 }, { x: 1, y: 1 }];
    const s = sampleCurve(pts, 8);
    expect(s.length).toBe(9);
    expect(s[0]).toEqual([0, 0]);
    expect(s[8][0]).toBe(1);
    expect(s[8][1]).toBeCloseTo(1, 6);
    // Midpoint follows the ease, not the straight line.
    const mid = s[4];
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(applyEase(0.5, 1), 6);
    expect(mid[1]).toBeGreaterThan(0.5);
  });
});
