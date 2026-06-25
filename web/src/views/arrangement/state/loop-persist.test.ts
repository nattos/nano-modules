import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { WorkspaceBackend } from '../workspace/backend';
import { emptyComposition, type Composition } from '../model/composition';

/** A read-only backend stub that always serves `comp` on read. */
function fakeBackend(comp: Composition): WorkspaceBackend {
  return {
    label: 'test',
    async list() { return []; },
    async read() { return JSON.parse(JSON.stringify(comp)); },
    async write() {},
    async create() {},
    async rename() {},
    async remove() {},
  };
}

/**
 * Loop markers are persisted on the Composition but written OUTSIDE the undo
 * stack (a transport preference, not a document edit), and restored on load.
 */
describe('loop persistence (no undo entries)', () => {
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
  });

  it('toggleLoop writes composition.loop and adds NO undo entry', () => {
    const enabledBefore = store.loopEnabled;
    store.addTrack(); // a real undoable edit → exactly one undo entry
    expect(store.canUndo).toBe(true);

    store.toggleLoop();

    expect(store.loopEnabled).toBe(!enabledBefore);
    expect(store.composition.loop).toEqual({
      enabled: store.loopEnabled,
      startBeat: store.loopStartBeat,
      endBeat: store.loopEndBeat,
    });
    // Undo reverses the addTrack; if toggleLoop had pushed an entry, one undo
    // would leave the stack non-empty.
    store.undo();
    expect(store.canUndo).toBe(false);
  });

  it('toggleLoopOrSetToTimeBox persists the snapped range without an undo entry', () => {
    store.setTimeSelection(4, 12, []);
    store.toggleLoopOrSetToTimeBox();
    expect(store.loopStartBeat).toBe(4);
    expect(store.loopEndBeat).toBe(12);
    expect(store.composition.loop).toEqual({ enabled: true, startBeat: 4, endBeat: 12 });
    expect(store.canUndo).toBe(false);
  });

  it('loading a composition WITH loop restores the store fields', async () => {
    const comp = emptyComposition();
    comp.loop = { enabled: false, startBeat: 16, endBeat: 48 };
    await store.openArrangement(fakeBackend(comp), 'with-loop.arr');
    expect(store.loopEnabled).toBe(false);
    expect(store.loopStartBeat).toBe(16);
    expect(store.loopEndBeat).toBe(48);
  });

  it('loading a composition WITHOUT loop keeps the current/default fields', async () => {
    store.loopEnabled = true;
    store.loopStartBeat = 0;
    store.loopEndBeat = 32;
    const comp = emptyComposition(); // no loop field
    await store.openArrangement(fakeBackend(comp), 'no-loop.arr');
    expect(store.loopEnabled).toBe(true);
    expect(store.loopStartBeat).toBe(0);
    expect(store.loopEndBeat).toBe(32);
  });

  it('the persisted loop survives a toJS/JSON round-trip', () => {
    store.toggleLoop();
    const clone = JSON.parse(JSON.stringify(store.composition)) as Composition;
    expect(clone.loop).toEqual({
      enabled: store.loopEnabled,
      startBeat: store.loopStartBeat,
      endBeat: store.loopEndBeat,
    });
  });
});
