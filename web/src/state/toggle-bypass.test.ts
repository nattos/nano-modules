/**
 * `0` shortcut → controller.toggleBypassSelectedEffects: toggle bypass across
 * the whole selection (single or multi-card) as one undo point, unifying mixed
 * states (enable all only when every card is already bypassed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain } from '../sketch-types';

function seedChain(n: number) {
  const chain: any[] = [];
  const instances: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    const key = `k${i}`;
    chain.push({ type: 'module', module_type: 'composite.blend', instance_key: key });
    instances[key] = { module_type: 'composite.blend', state: {}, version: 1 };
  }
  runInAction(() => {
    appState.database.sketches = { sk: { anchor: null, chain, wires: [], instances } } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

const bypassOf = (i: number) => {
  const entry = sketchChain(appState.database.sketches['sk'] as any)[i] as any;
  return appState.database.sketches['sk']!.instances![entry.instance_key].state.__bypass__;
};

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.selection = null;
    appState.local.multiSelection = [];
  });
});

describe('toggleBypassSelectedEffects', () => {
  it('toggles the single selected card on and off', () => {
    seedChain(1);
    appController.select('effect/sk/0/0');
    const h0 = appController.history.history.length;

    expect(appController.toggleBypassSelectedEffects()).toBe(true);
    expect(bypassOf(0)).toBe(true);
    expect(appController.history.history.length).toBe(h0 + 1);

    appController.toggleBypassSelectedEffects();
    expect(bypassOf(0)).toBe(false);
  });

  it('toggles all multi-selected cards as one undo point', () => {
    seedChain(3);
    appController.select('effect/sk/0/0');
    appController.toggleSelectEffect('effect/sk/0/1');
    appController.toggleSelectEffect('effect/sk/0/2');
    const h0 = appController.history.history.length;

    appController.toggleBypassSelectedEffects();
    expect(bypassOf(0)).toBe(true);
    expect(bypassOf(1)).toBe(true);
    expect(bypassOf(2)).toBe(true);
    expect(appController.history.history.length).toBe(h0 + 1); // one undo point

    // One undo restores all three.
    appController.history.undo();
    expect(bypassOf(0)).toBeFalsy();
    expect(bypassOf(1)).toBeFalsy();
    expect(bypassOf(2)).toBeFalsy();
  });

  it('unifies a mixed selection: bypass all when any is enabled', () => {
    seedChain(2);
    // Card 0 already bypassed, card 1 enabled.
    runInAction(() => {
      appState.database.sketches['sk']!.instances!['k0'].state.__bypass__ = true;
    });
    appController.select('effect/sk/0/0');
    appController.toggleSelectEffect('effect/sk/0/1');

    appController.toggleBypassSelectedEffects();
    // Not all were bypassed → target is "bypass all".
    expect(bypassOf(0)).toBe(true);
    expect(bypassOf(1)).toBe(true);

    // Now all bypassed → next toggle enables all.
    appController.toggleBypassSelectedEffects();
    expect(bypassOf(0)).toBe(false);
    expect(bypassOf(1)).toBe(false);
  });

  it('returns false when nothing (or a non-effect) is selected', () => {
    seedChain(1);
    appController.select(null);
    expect(appController.toggleBypassSelectedEffects()).toBe(false);
  });
});
