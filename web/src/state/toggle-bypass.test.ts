/**
 * `0` shortcut → controller.toggleBypassSelectedEffects: toggle bypass across
 * the whole selection (single or multi-card) as one undo point, unifying mixed
 * states (enable all only when every card is already bypassed).
 *
 * The stored key is `__enable__` (1 = the effect runs) — see isDeviceOff. An
 * ABSENT key means enabled, so the tests distinguish "no key" from "off".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain, isDeviceOff } from '../sketch-types';

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

const stateOf = (i: number) => {
  const entry = sketchChain(appState.database.sketches['sk'] as any)[i] as any;
  return appState.database.sketches['sk']!.instances![entry.instance_key].state as Record<string, unknown>;
};
/** Is card `i` bypassed? (the executor's rule: only an explicit 0/false is off) */
const bypassed = (i: number) => isDeviceOff(stateOf(i));

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

    // A fresh card carries no `__enable__` key at all — and runs.
    expect(stateOf(0).__enable__).toBeUndefined();
    expect(bypassed(0)).toBe(false);

    expect(appController.toggleBypassSelectedEffects()).toBe(true);
    expect(stateOf(0).__enable__).toBe(false);   // written as enable=0, not bypass=1
    expect(bypassed(0)).toBe(true);
    expect(appController.history.history.length).toBe(h0 + 1);

    appController.toggleBypassSelectedEffects();
    expect(stateOf(0).__enable__).toBe(true);
    expect(bypassed(0)).toBe(false);
  });

  it('toggles all multi-selected cards as one undo point', () => {
    seedChain(3);
    appController.select('effect/sk/0/0');
    appController.toggleSelectEffect('effect/sk/0/1');
    appController.toggleSelectEffect('effect/sk/0/2');
    const h0 = appController.history.history.length;

    appController.toggleBypassSelectedEffects();
    expect(bypassed(0)).toBe(true);
    expect(bypassed(1)).toBe(true);
    expect(bypassed(2)).toBe(true);
    expect(appController.history.history.length).toBe(h0 + 1); // one undo point

    // One undo restores all three — back to no key, i.e. enabled.
    appController.history.undo();
    expect(stateOf(0).__enable__).toBeUndefined();
    expect(bypassed(0)).toBe(false);
    expect(bypassed(1)).toBe(false);
    expect(bypassed(2)).toBe(false);
  });

  it('unifies a mixed selection: bypass all when any is enabled', () => {
    seedChain(2);
    // Card 0 already bypassed, card 1 enabled.
    runInAction(() => {
      appState.database.sketches['sk']!.instances!['k0'].state.__enable__ = false;
    });
    appController.select('effect/sk/0/0');
    appController.toggleSelectEffect('effect/sk/0/1');

    appController.toggleBypassSelectedEffects();
    // Not all were bypassed → target is "bypass all".
    expect(bypassed(0)).toBe(true);
    expect(bypassed(1)).toBe(true);

    // Now all bypassed → next toggle enables all.
    appController.toggleBypassSelectedEffects();
    expect(bypassed(0)).toBe(false);
    expect(bypassed(1)).toBe(false);
  });

  it('returns false when nothing (or a non-effect) is selected', () => {
    seedChain(1);
    appController.select(null);
    expect(appController.toggleBypassSelectedEffects()).toBe(false);
  });
});
