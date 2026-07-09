/**
 * Controller clip-control surface: trigger/reassign route through the installed
 * barrel commander, and the trigger-clip selection is mutually exclusive with
 * the sidechannel selection in the right panel.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { BarrelClipCommand } from '../engine-types';

afterEach(() => {
  appController.setBarrelClipCommander(null);
  runInAction(() => {
    appState.local.selectedTriggerClip = null;
    appState.local.selectedSidechannel = null;
    appState.local.engine.clipStates = {};
  });
});

describe('clip commands', () => {
  it('triggerClip routes a trigger command (by key and by layer/clip)', () => {
    const cmds: BarrelClipCommand[] = [];
    appController.setBarrelClipCommander(c => cmds.push(c));

    appController.triggerClip({ key: 'm1' }, true);
    appController.triggerClip({ layer: 2, clip: 3 }, false);

    expect(cmds).toEqual([
      { kind: 'trigger', key: 'm1', on: true },
      { kind: 'trigger', layer: 2, clip: 3, on: false },
    ]);
  });

  it('reassignClipChannel routes a reassign command', () => {
    const cmds: BarrelClipCommand[] = [];
    appController.setBarrelClipCommander(c => cmds.push(c));
    appController.reassignClipChannel('m1', 5);
    expect(cmds).toEqual([{ kind: 'reassign', key: 'm1', channel: 5 }]);
  });

  it('no-ops safely when no commander is wired', () => {
    appController.setBarrelClipCommander(null);
    expect(() => appController.triggerClip({ key: 'm1' }, true)).not.toThrow();
  });

  it('selecting a trigger clip clears the sidechannel selection, and vice-versa', () => {
    appController.selectSidechannel('2');
    expect(appState.local.selectedSidechannel).toBe('2');

    appController.selectTriggerClip({ key: 'm1', channel: 3 });
    expect(appState.local.selectedTriggerClip).toEqual({ key: 'm1', channel: 3 });
    expect(appState.local.selectedSidechannel).toBeNull();

    appController.selectSidechannel('4');
    expect(appState.local.selectedTriggerClip).toBeNull();
  });

  it('setClipStates adopts the map', () => {
    appController.setClipStates({ '0:1': true });
    expect(appState.local.engine.clipStates['0:1']).toBe(true);
  });
});
