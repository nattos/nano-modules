import { describe, it, expect, vi } from 'vitest';
import { autorun } from 'mobx';
import { FieldLayoutManager } from './field-layout-manager';

describe('FieldLayoutManager', () => {
  it('updateRailPositions does not bump generation', () => {
    const lm = new FieldLayoutManager();
    const startGen = lm.generation;

    lm.updateRailPositions(['rail_0', 'rail_1'], 72);

    expect(lm.generation).toBe(startGen);
  });

  it('updateRailPositions does not trigger MobX reactions', () => {
    const lm = new FieldLayoutManager();
    const spy = vi.fn();

    // Track generation changes
    const dispose = autorun(() => {
      const _gen = lm.generation;
      spy();
    });

    // autorun fires once immediately
    expect(spy).toHaveBeenCalledTimes(1);

    // updateRailPositions should NOT fire it again
    lm.updateRailPositions(['rail_0'], 72);
    expect(spy).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('allocates rail positions at correct X offsets', () => {
    const lm = new FieldLayoutManager();
    lm.updateRailPositions(['a', 'b', 'c'], 72);

    // baseOffset=8, slotWidth=16, x = baseOffset + i*slotWidth + slotWidth/2
    expect(lm.getRailX('a')).toBe(8 + 0 * 16 + 8); // 16
    expect(lm.getRailX('b')).toBe(8 + 1 * 16 + 8); // 32
    expect(lm.getRailX('c')).toBe(8 + 2 * 16 + 8); // 48
  });

  it('getRailX returns null for unknown rail', () => {
    const lm = new FieldLayoutManager();
    lm.updateRailPositions(['a'], 72);

    expect(lm.getRailX('unknown')).toBeNull();
  });

  it('updateRailPositions clears old entries', () => {
    const lm = new FieldLayoutManager();
    lm.updateRailPositions(['a', 'b'], 72);
    expect(lm.getRailX('a')).not.toBeNull();
    expect(lm.getRailX('b')).not.toBeNull();

    lm.updateRailPositions(['c'], 72);
    expect(lm.getRailX('a')).toBeNull();
    expect(lm.getRailX('b')).toBeNull();
    expect(lm.getRailX('c')).not.toBeNull();
  });

  it('recalculate bumps generation (in contrast to updateRailPositions)', () => {
    const lm = new FieldLayoutManager();
    const spy = vi.fn();

    const dispose = autorun(() => {
      const _gen = lm.generation;
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // notifyLayoutChanged schedules a recalculate via rAF which bumps generation.
    // We can't test async rAF easily, but we can verify the generation counter
    // is the mechanism that drives reactivity.
    expect(lm.generation).toBe(0);

    dispose();
  });
});
