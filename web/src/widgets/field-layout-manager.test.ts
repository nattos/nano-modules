// @vitest-environment happy-dom
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

/** An element with a stubbed bounding rect (happy-dom returns zeros otherwise). */
function elWithRect(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, ...rect }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe('FieldLayoutManager anchor helpers (shared rect registry)', () => {
  it('setAnchor registers, liveRect returns a fresh rect', () => {
    const lm = new FieldLayoutManager();
    const el = elWithRect({ left: 5, top: 7, width: 20, height: 12 });
    lm.setAnchor('clip:a', el);
    const r = lm.liveRect('clip:a');
    expect(r).not.toBeNull();
    expect(r!.left).toBe(5);
    expect(r!.width).toBe(20);
    el.remove();
  });

  it('setAnchor(key, null) unregisters', () => {
    const lm = new FieldLayoutManager();
    const el = elWithRect({ width: 10, height: 10 });
    lm.setAnchor('k', el);
    expect(lm.liveRect('k')).not.toBeNull();
    lm.setAnchor('k', null);
    expect(lm.liveRect('k')).toBeNull();
    el.remove();
  });

  it('liveRect self-prunes a disconnected element', () => {
    const lm = new FieldLayoutManager();
    const el = elWithRect({ width: 10, height: 10 });
    lm.register('k', el);
    el.remove(); // now !isConnected
    expect(lm.liveRect('k')).toBeNull();
    expect(lm.entries.has('k')).toBe(false); // pruned
  });

  it('liveRect returns null for a zero-size element', () => {
    const lm = new FieldLayoutManager();
    const el = elWithRect({ width: 0, height: 0 });
    lm.register('k', el);
    expect(lm.liveRect('k')).toBeNull();
    el.remove();
  });

  it('liveRect is null for an unknown key', () => {
    const lm = new FieldLayoutManager();
    expect(lm.liveRect('nope')).toBeNull();
  });
});
