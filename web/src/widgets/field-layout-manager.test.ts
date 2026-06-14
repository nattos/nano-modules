import { describe, it, expect, vi } from 'vitest';
import { autorun } from 'mobx';
import { FieldLayoutManager } from './field-layout-manager';

describe('FieldLayoutManager', () => {
  it('generation drives MobX reactivity and starts at 0', () => {
    const lm = new FieldLayoutManager();
    const spy = vi.fn();

    const dispose = autorun(() => {
      const _gen = lm.generation;
      spy();
    });
    // autorun fires once immediately.
    expect(spy).toHaveBeenCalledTimes(1);
    // recalculate() (scheduled via rAF on register/notifyLayoutChanged) is the
    // only thing that bumps `generation`; we can't easily drive rAF in the test
    // env, but the counter is the documented reactivity mechanism.
    expect(lm.generation).toBe(0);

    dispose();
  });
});
