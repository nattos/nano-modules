import { describe, it, expect } from 'vitest';
import { applyTapMod, combineTap, applyMagnitude } from './tap-mod';
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

  it('applies scale AFTER remap (scales the modulation output, not the input)', () => {
    // Non-zero outMin makes the order observable: remap(5)=150, then *2 = 300.
    // (Old scale-first would be remap(5*2=10)=200.)
    const mod: TapMod = { scale: 2, remap: { inMin: 0, inMax: 10, outMin: 100, outMax: 200 } };
    expect(applyTapMod(5, mod)).toBeCloseTo(300, 6);
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

// Magnitude modes map a standard-range source value into the dest field's
// declared [min,max]. Range 0..3 (span 3, mid 1.5) makes the mapping visible.
describe('applyMagnitude', () => {
  const MIN = 0, MAX = 3;   // span 3, mid 1.5

  it('signed replace maps −1..1 → min..max', () => {
    expect(applyMagnitude(0, -1, 'signed', 'replace', undefined, MIN, MAX)).toBeCloseTo(0, 6);
    expect(applyMagnitude(0,  0, 'signed', 'replace', undefined, MIN, MAX)).toBeCloseTo(1.5, 6);
    expect(applyMagnitude(0,  1, 'signed', 'replace', undefined, MIN, MAX)).toBeCloseTo(3, 6);
  });

  it('unsigned replace maps 0..1 → min..max', () => {
    expect(applyMagnitude(0, 0, 'unsigned', 'replace', undefined, MIN, MAX)).toBeCloseTo(0, 6);
    expect(applyMagnitude(0, 0.5, 'unsigned', 'replace', undefined, MIN, MAX)).toBeCloseTo(1.5, 6);
    expect(applyMagnitude(0, 1, 'unsigned', 'replace', undefined, MIN, MAX)).toBeCloseTo(3, 6);
  });

  it('add pushes by ±input*span around the existing value (signed == unsigned)', () => {
    expect(applyMagnitude(1, 1, 'signed', 'add', undefined, MIN, MAX)).toBeCloseTo(4, 6);    // +span
    expect(applyMagnitude(1, -1, 'signed', 'add', undefined, MIN, MAX)).toBeCloseTo(-2, 6);  // −span
    expect(applyMagnitude(1, 0, 'signed', 'add', undefined, MIN, MAX)).toBeCloseTo(1, 6);    // neutral
    expect(applyMagnitude(1, 0.5, 'unsigned', 'add', undefined, MIN, MAX)).toBeCloseTo(2.5, 6);
  });

  it('signed mul scales the existing delta around the midpoint', () => {
    const ex = 2;          // mid = 1.5, delta = +0.5
    expect(applyMagnitude(ex, 1, 'signed', 'mul', undefined, MIN, MAX)).toBeCloseTo(2, 6);    // identity
    expect(applyMagnitude(ex, 0, 'signed', 'mul', undefined, MIN, MAX)).toBeCloseTo(1.5, 6);  // → mid
    expect(applyMagnitude(ex, -1, 'signed', 'mul', undefined, MIN, MAX)).toBeCloseTo(1, 6);   // flips delta
  });

  it('unsigned mul scales the existing value from the min', () => {
    const ex = 2;          // min = 0
    expect(applyMagnitude(ex, 1, 'unsigned', 'mul', undefined, MIN, MAX)).toBeCloseTo(2, 6);  // identity
    expect(applyMagnitude(ex, 0, 'unsigned', 'mul', undefined, MIN, MAX)).toBeCloseTo(0, 6);  // → min
    expect(applyMagnitude(ex, 0.5, 'unsigned', 'mul', undefined, MIN, MAX)).toBeCloseTo(1, 6);
  });

  it('mix blends the existing value toward the mapped replace value', () => {
    // unsigned replace of input 1 → max (3); mix from existing 1 by 0.5 → 2.
    expect(applyMagnitude(1, 1, 'unsigned', 'mix', 0.5, MIN, MAX)).toBeCloseTo(2, 6);
    expect(applyMagnitude(1, 1, 'unsigned', 'mix', 1, MIN, MAX)).toBeCloseTo(3, 6);
    expect(applyMagnitude(1, 1, 'unsigned', 'mix', 0, MIN, MAX)).toBeCloseTo(1, 6);
    // signed replace of input 0 → mid (1.5); mix from 0 by 1 → 1.5.
    expect(applyMagnitude(0, 0, 'signed', 'mix', 1, MIN, MAX)).toBeCloseTo(1.5, 6);
  });

  it('a 0..1 dest field makes unsigned replace a pass-through (== absolute)', () => {
    // Why current 0..1-target wires are unaffected by the default Auto→unsigned.
    expect(applyMagnitude(0.7, 0.5, 'unsigned', 'replace', undefined, 0, 1)).toBeCloseTo(0.5, 6);
  });
});
