import { describe, it, expect } from 'vitest';
import { applyTapMod, combineTap } from './tap-mod';
import type { TapMod } from './sketch-types';

// These goldens are the LOCK-STEP contract between web/src/tap-mod.ts and
// native/src/sketch/tap_mod.h — the native Catch2 mirror asserts the same numbers.
// If you change a formula, change both and update these values.

describe('applyTapMod', () => {
  it('passes the value through unchanged when there is no mod', () => {
    expect(applyTapMod(0.5)).toBe(0.5);
    expect(applyTapMod(-3.2)).toBe(-3.2);
  });

  it('scales from 0', () => {
    expect(applyTapMod(0.5, { scale: 2 })).toBeCloseTo(1.0, 6);
    expect(applyTapMod(4, { scale: 0.25 })).toBeCloseTo(1.0, 6);
  });

  it('remaps a linear range', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 10, outMin: 0, outMax: 1 } };
    expect(applyTapMod(5, mod)).toBeCloseTo(0.5, 6);
    expect(applyTapMod(0, mod)).toBeCloseTo(0, 6);
    expect(applyTapMod(10, mod)).toBeCloseTo(1, 6);
  });

  it('remaps across non-zero output bounds', () => {
    const mod: TapMod = { remap: { inMin: -1, inMax: 1, outMin: 100, outMax: 200 } };
    expect(applyTapMod(0, mod)).toBeCloseTo(150, 6);
    expect(applyTapMod(-1, mod)).toBeCloseTo(100, 6);
  });

  it('saturates the input when requested', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 10, outMin: 0, outMax: 1, saturate: true } };
    expect(applyTapMod(15, mod)).toBeCloseTo(1, 6);
    expect(applyTapMod(-5, mod)).toBeCloseTo(0, 6);
  });

  it('does NOT clamp when saturate is off (linear extrapolates)', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 10, outMin: 0, outMax: 1 } };
    expect(applyTapMod(15, mod)).toBeCloseTo(1.5, 6);
  });

  it('applies the quad ease-in curve', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 10, outMin: 0, outMax: 100, curveIn: 'quad' } };
    expect(applyTapMod(5, mod)).toBeCloseTo(25, 6); // 0.5^2 * 100
  });

  it('applies the circular ease-in curve', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, curveIn: 'circular' } };
    expect(applyTapMod(0.5, mod)).toBeCloseTo(1 - Math.sqrt(0.75), 6);
  });

  it('applies the power curve with a custom exponent', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, curveIn: 'power', exponent: 3 } };
    expect(applyTapMod(0.5, mod)).toBeCloseTo(0.125, 6);
  });

  it('mirrors the base curve for ease-out (curveOut)', () => {
    // ease-out quad: 1 - (1-t)^2 ; at t=0.5 -> 0.75
    const mod: TapMod = { remap: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, curveOut: 'quad' } };
    expect(applyTapMod(0.5, mod)).toBeCloseTo(0.75, 6);
  });

  it('folds out-of-range input back into range with foldback', () => {
    const mod: TapMod = { remap: { inMin: 0, inMax: 10, outMin: 0, outMax: 1, curveIn: 'foldback' } };
    expect(applyTapMod(12, mod)).toBeCloseTo(0.8, 6); // 1.2 -> fold -> 0.8
    expect(applyTapMod(8, mod)).toBeCloseTo(0.8, 6); // in range, identity
  });

  it('maps to outMin when inMin == inMax (no divide-by-zero)', () => {
    const mod: TapMod = { remap: { inMin: 5, inMax: 5, outMin: 7, outMax: 9 } };
    expect(applyTapMod(5, mod)).toBeCloseTo(7, 6);
  });

  it('applies scale before remap', () => {
    const mod: TapMod = { scale: 2, remap: { inMin: 0, inMax: 10, outMin: 0, outMax: 1 } };
    expect(applyTapMod(5, mod)).toBeCloseTo(1.0, 6); // 5*2=10 -> t=1 -> 1
  });
});

describe('combineTap', () => {
  it('seeds the rail when there is no existing value (first writer)', () => {
    expect(combineTap(undefined, 3, 'add')).toBe(3);
    expect(combineTap(undefined, 3, 'mul')).toBe(3);
    expect(combineTap(undefined, 3, 'mix', 0.5)).toBe(3);
  });

  it('replaces by default', () => {
    expect(combineTap(2, 3)).toBe(3);
    expect(combineTap(2, 3, 'replace')).toBe(3);
  });

  it('adds and multiplies', () => {
    expect(combineTap(2, 3, 'add')).toBe(5);
    expect(combineTap(2, 3, 'mul')).toBe(6);
  });

  it('mixes (lerp) with the per-tap factor', () => {
    expect(combineTap(2, 3, 'mix', 0.5)).toBeCloseTo(2.5, 6);
    expect(combineTap(2, 3, 'mix', 1)).toBeCloseTo(3, 6);
    expect(combineTap(2, 3, 'mix')).toBeCloseTo(3, 6); // default factor 1
    expect(combineTap(2, 3, 'mix', 0)).toBeCloseTo(2, 6);
  });
});
