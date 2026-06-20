import { describe, it, expect } from 'vitest';
import { applyEase, evalEnvelope, parseCurve, serializeCurve, type EnvPoint } from './envelope-math';

// Mirrors native/tests/test_envelope.cpp — the TS draw-math must match the
// effect's C++ eval (envelope.h) so the drawn curve reflects what runs.

describe('evalEnvelope', () => {
  it('evaluates a linear identity curve', () => {
    const pts: EnvPoint[] = [{ x: 0, y: 0, ease: 0 }, { x: 1, y: 1, ease: 0 }];
    expect(evalEnvelope(pts, 0)).toBeCloseTo(0, 6);
    expect(evalEnvelope(pts, 0.25)).toBeCloseTo(0.25, 6);
    expect(evalEnvelope(pts, 0.5)).toBeCloseTo(0.5, 6);
    expect(evalEnvelope(pts, 1)).toBeCloseTo(1, 6);
  });

  it('clamps flat outside the point range', () => {
    const pts: EnvPoint[] = [{ x: 0.25, y: 0.2, ease: 0 }, { x: 0.75, y: 0.9, ease: 0 }];
    expect(evalEnvelope(pts, 0)).toBeCloseTo(0.2, 6);
    expect(evalEnvelope(pts, 1)).toBeCloseTo(0.9, 6);
    expect(evalEnvelope(pts, 0.5)).toBeCloseTo(0.55, 6);
    expect(evalEnvelope([], 0.5)).toBe(0);
  });

  it('eases the segment but keeps endpoints exact', () => {
    const up: EnvPoint[] = [{ x: 0, y: 0, ease: 1 }, { x: 1, y: 1, ease: 0 }];
    expect(evalEnvelope(up, 0)).toBeCloseTo(0, 6);
    expect(evalEnvelope(up, 1)).toBeCloseTo(1, 6);
    expect(evalEnvelope(up, 0.5)).toBeGreaterThan(0.55);       // bulges above the line
    expect(evalEnvelope(up, 0.5)).toBeCloseTo(Math.pow(0.5, Math.pow(2, -3)), 6);
    const down: EnvPoint[] = [{ x: 0, y: 0, ease: -1 }, { x: 1, y: 1, ease: 0 }];
    expect(evalEnvelope(down, 0.5)).toBeLessThan(0.45);        // bulges below
  });

  it('evaluates a multi-segment peak curve', () => {
    const pts = parseCurve('[0,0,0, 0.5,1,0, 1,0,0]');
    expect(evalEnvelope(pts, 0.25)).toBeCloseTo(0.5, 6);
    expect(evalEnvelope(pts, 0.5)).toBeCloseTo(1.0, 6);
    expect(evalEnvelope(pts, 0.75)).toBeCloseTo(0.5, 6);
  });
});

describe('applyEase', () => {
  it('is identity at ease 0 and pins endpoints', () => {
    expect(applyEase(0.3, 0)).toBeCloseTo(0.3, 6);
    expect(applyEase(0, 0.7)).toBe(0);
    expect(applyEase(1, -0.7)).toBe(1);
  });
});

describe('parseCurve / serializeCurve', () => {
  it('parses a flat triple array', () => {
    const pts = parseCurve('[0,0,0, 0.5,0.8,0.5, 1,1,0]');
    expect(pts.length).toBe(3);
    expect(pts[1]).toEqual({ x: 0.5, y: 0.8, ease: 0.5 });
  });

  it('falls back to identity on empty/garbage and sorts/clamps', () => {
    expect(parseCurve('[]')).toEqual([{ x: 0, y: 0, ease: 0 }, { x: 1, y: 1, ease: 0 }]);
    expect(parseCurve('not json')).toEqual([{ x: 0, y: 0, ease: 0 }, { x: 1, y: 1, ease: 0 }]);
    // out-of-order points get sorted; out-of-range clamped.
    const pts = parseCurve('[1,2,5, 0,-1,-5, 0.5,0.5,0]');
    expect(pts.map(p => p.x)).toEqual([0, 0.5, 1]);
    expect(pts[0].y).toBe(0);        // -1 clamped to 0
    expect(pts[2].y).toBe(1);        // 2 clamped to 1
    expect(pts[2].ease).toBe(1);     // 5 clamped to 1
  });

  it('round-trips through serialize', () => {
    const pts = parseCurve('[0,0,0,0.3,0.9,-0.4,1,0.2,0]');
    expect(parseCurve(serializeCurve(pts))).toEqual(pts);
  });
});
