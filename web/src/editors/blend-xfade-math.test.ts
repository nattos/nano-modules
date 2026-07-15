/**
 * Anchor goldens for the crossfade `shape` weight family. These pin the TS
 * mirror to the values the C++ home (native/src/sketch/xfade_shape.h) produces
 * — if either side changes shape families, one of these breaks.
 */
import { describe, it, expect } from 'vitest';
import { xfadeWeightA, xfadeWeightB } from './blend-xfade-math';

describe('xfade shape weight family', () => {
  it('shape 0 is the hard linear ramp (legacy)', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      expect(xfadeWeightB(t, 0)).toBeCloseTo(t, 6);
      expect(xfadeWeightA(t, 0)).toBeCloseTo(1 - t, 6);
    }
  });

  it('shape 0.5 is true equal-power (sin/cos, unit power sum)', () => {
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      const wB = xfadeWeightB(t, 0.5);
      const wA = xfadeWeightA(t, 0.5);
      expect(wB).toBeCloseTo(Math.sin((t * Math.PI) / 2), 6);
      expect(wA * wA + wB * wB).toBeCloseTo(1, 6);
    }
    expect(xfadeWeightB(0.5, 0.5)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('shape 1 is the trapezoid: full by mid-fade, both full at center', () => {
    expect(xfadeWeightB(0.25, 1)).toBeCloseTo(0.5, 6);
    expect(xfadeWeightB(0.5, 1)).toBeCloseTo(1, 6);
    expect(xfadeWeightB(0.75, 1)).toBeCloseTo(1, 6);
    expect(xfadeWeightA(0.5, 1)).toBeCloseTo(1, 6);
  });

  it('endpoints are exact at every shape', () => {
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      expect(xfadeWeightB(0, s)).toBeCloseTo(0, 6);
      expect(xfadeWeightB(1, s)).toBeCloseTo(1, 6);
      expect(xfadeWeightA(0, s)).toBeCloseTo(1, 6);
      expect(xfadeWeightA(1, s)).toBeCloseTo(0, 6);
    }
  });

  it('is monotone in t for every shape', () => {
    for (const s of [0, 0.2, 0.5, 0.8, 1]) {
      let prev = -1e-9;
      for (let i = 0; i <= 64; i++) {
        const w = xfadeWeightB(i / 64, s);
        expect(w).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = w;
      }
    }
  });

  it('inputs clamp to [0,1]', () => {
    expect(xfadeWeightB(-0.5, 2)).toBeCloseTo(0, 6);
    expect(xfadeWeightB(1.5, -1)).toBeCloseTo(1, 6);
  });
});
