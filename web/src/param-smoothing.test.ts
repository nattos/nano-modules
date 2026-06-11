import { describe, it, expect } from 'vitest';
import { initSmooth, advanceSmooth } from './param-smoothing';

describe('advanceSmooth', () => {
  it('ramps linearly to a stepped target and then holds (finite time, no overshoot)', () => {
    // Settled at 0, then the target steps to 1 with a 1s linear ramp at dt=0.25.
    const st = initSmooth(0, 1);
    expect(advanceSmooth(st, 1, 1, 0.25)).toBeCloseTo(0.25, 6);
    expect(advanceSmooth(st, 1, 1, 0.25)).toBeCloseTo(0.5, 6);
    expect(advanceSmooth(st, 1, 1, 0.25)).toBeCloseTo(0.75, 6);
    expect(advanceSmooth(st, 1, 1, 0.25)).toBeCloseTo(1.0, 6);
    // Holds exactly at the target — no overshoot, no residual exponential decay.
    expect(advanceSmooth(st, 1, 1, 0.25)).toBe(1.0);
    expect(advanceSmooth(st, 1, 1, 5.0)).toBe(1.0);
  });

  it('clamps the ramp and reaches the target exactly in one big step', () => {
    const st = initSmooth(0, 1);
    expect(advanceSmooth(st, 1, 1, 10)).toBe(1.0);
  });

  it('treats duration <= 0 as instant', () => {
    const st = initSmooth(0, 0);
    expect(advanceSmooth(st, 1, 0, 0.016)).toBe(1.0);
    const st2 = initSmooth(5, 0.5);
    expect(advanceSmooth(st2, -3, -1, 0.016)).toBe(-3);
  });

  it('restarts from the current value on a mid-ramp retarget', () => {
    const st = initSmooth(0, 1);
    advanceSmooth(st, 1, 1, 0.25); // current = 0.25, heading to 1
    expect(st.current).toBeCloseTo(0.25, 6);
    // Retarget to 0 while mid-ramp: start := current (0.25), timer resets.
    advanceSmooth(st, 0, 1, 0.0);
    expect(st.start).toBeCloseTo(0.25, 6);
    expect(st.target).toBe(0);
    expect(st.elapsed).toBe(0);
    // Now ramps 0.25 -> 0 over 1s.
    expect(advanceSmooth(st, 0, 1, 0.5)).toBeCloseTo(0.125, 6);
    expect(advanceSmooth(st, 0, 1, 0.5)).toBeCloseTo(0.0, 6);
  });

  it('starts settled (initSmooth) so a freshly-loaded param does not ramp from 0', () => {
    const st = initSmooth(0.7, 1);
    // Same target on the first frame ⇒ no reset, already at the value.
    expect(advanceSmooth(st, 0.7, 1, 0.016)).toBe(0.7);
  });
});
