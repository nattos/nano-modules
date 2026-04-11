import { describe, it, expect, vi, afterEach } from 'vitest';
import { autorun, runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';

afterEach(() => {
  // Clean up selection state between tests
  runInAction(() => {
    appState.local.selection = null;
    appState.local.queuedSelectionPath = null;
  });
});

describe('Selectable system', () => {
  it('defineSelectable does not trigger MobX reactions when path is not selected', () => {
    const spy = vi.fn();

    const dispose = autorun(() => {
      // Observe the selection (as the inspector panel would)
      const _sel = appState.local.selection;
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // Defining a selectable that isn't selected should NOT trigger a reaction
    appController.defineSelectable({
      path: 'test/1',
      label: 'Test',
    });

    expect(spy).toHaveBeenCalledTimes(1); // Still 1 — no reaction fired

    dispose();
  });

  it('defineSelectable promotes queued selection exactly once', () => {
    const spy = vi.fn();

    // Queue a selection
    appController.select('test/queued');
    expect(appState.local.queuedSelectionPath).toBe('test/queued');
    expect(appState.local.selection).toBeNull();

    const dispose = autorun(() => {
      const _sel = appState.local.selection;
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // defineSelectable with the queued path — should promote (one reaction)
    appController.defineSelectable({
      path: 'test/queued',
      label: 'Queued',
    });

    expect(spy).toHaveBeenCalledTimes(2); // Exactly one additional reaction
    expect(appState.local.selection?.path).toBe('test/queued');
    expect(appState.local.queuedSelectionPath).toBeNull();

    // Calling defineSelectable again with the same path should NOT react
    appController.defineSelectable({
      path: 'test/queued',
      label: 'Queued Again',
    });

    expect(spy).toHaveBeenCalledTimes(2); // No additional reaction

    dispose();

  });

  it('re-defining a selected selectable does not trigger reaction cycle', () => {
    // Select something first
    appController.defineSelectable({ path: 'test/cycle', label: 'Cycle' });
    appController.select('test/cycle');

    let reactionCount = 0;
    const dispose = autorun(() => {
      const _sel = appState.local.selection;
      reactionCount++;

      // Simulate what render() does — re-define the selectable
      if (reactionCount < 10) {
        appController.defineSelectable({ path: 'test/cycle', label: 'Cycle Updated' });
      }
    });

    // Should converge: autorun fires once, defineSelectable doesn't re-trigger it
    expect(reactionCount).toBeLessThan(5);

    dispose();
    runInAction(() => { appState.local.selection = null; });
  });

  it('select sets selection from registry', () => {
    appController.defineSelectable({ path: 'test/direct', label: 'Direct' });
    appController.select('test/direct');

    expect(appState.local.selection?.path).toBe('test/direct');
    expect(appState.local.selection?.label).toBe('Direct');

  });

  it('select(null) clears selection', () => {
    appController.defineSelectable({ path: 'test/clear', label: 'Clear' });
    appController.select('test/clear');
    expect(appState.local.selection).not.toBeNull();

    appController.select(null);
    expect(appState.local.selection).toBeNull();
  });
});
