/**
 * New effect instances record the {module, effect} version pair, sourced from
 * the live plugin metadata (effect = state::init version, module = bundle
 * version). See controller.versionForModule + the creation sites.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain } from '../sketch-types';
import type { PluginInfo } from './types';

function seed() {
  runInAction(() => {
    appState.local.plugins = [
      { key: 'composite.blend@0', id: 'composite.blend', version: '2.3.4',
        moduleVersion: '1.5.0', params: [], io: [], schema: {} } as PluginInfo,
    ];
    appState.database.sketches = {
      sk: { anchor: null, chain: [], wires: [], instances: {} },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.plugins = [];
  });
});

describe('instance version stamping', () => {
  it('records effect + module version from the plugin at creation', () => {
    seed();
    appController.addEffectToChain('sk', 0, 0, 'composite.blend');

    const chain = sketchChain(appState.database.sketches['sk'] as any);
    const key = (chain[0] as any).instance_key;
    const inst = appState.database.sketches['sk'].instances![key];
    expect(inst.version).toEqual({ module: [1, 5, 0], effect: [2, 3, 4] });
  });

  it('records 0.0.0 for an unknown module (slot always present)', () => {
    seed();
    appController.addEffectToChain('sk', 0, 0, 'does.not.exist');
    const chain = sketchChain(appState.database.sketches['sk'] as any);
    const key = (chain[0] as any).instance_key;
    const inst = appState.database.sketches['sk'].instances![key];
    expect(inst.version).toEqual({ module: [0, 0, 0], effect: [0, 0, 0] });
  });
});
