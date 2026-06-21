import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain } from '../sketch-types';
import type { PluginInfo } from './types';

// Regression: a freshly-created instance must NOT seed OUTPUT fields into its
// authored state. Output fields are live-published by the running effect; baking
// the schema default (0) shadows the engine's published value in the field
// binding, pinning the scalar output trace at 0.0 (until a save+reload dropped
// it). New instances behaved differently from pasted / default-sketch ones,
// whose hand-authored state never carried the output key.
//
// A modulation-source effect: one input (`amplitude`) + one live output
// (`output`, io = Output|Primary = 6). The legacy `params` list carries BOTH
// (it has no io), so the seeder must filter the output in both passes.
const LFO_PLUGIN: PluginInfo = {
  id: 'mod.source.lfo',
  key: 'mod.source.lfo',
  version: '1',
  params: [
    { index: 0, name: 'amplitude', type: 10, defaultValue: 1, min: 0, max: 1 },
    { index: 1, name: 'output', type: 10, defaultValue: 0, min: 0, max: 1 },
  ],
  io: [],
  schema: {
    amplitude: { type: 'float', default: 1, min: 0, max: 1, io: 5 /* PrimaryInput */ },
    output: { type: 'float', default: 0, min: 0, max: 1, io: 6 /* PrimaryOutput */ },
  },
} as any;

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.plugins = [];
  });
});

describe('fresh instance output-field seeding', () => {
  it('does not bake output fields into a new instance state', () => {
    runInAction(() => {
      appState.local.plugins = [LFO_PLUGIN];
      appState.database.sketches = {
        sk: { anchor: null, chain: [], instances: {} },
      } as any;
    });

    appController.addEffectToChain('sk', 0, 0, 'mod.source.lfo');

    const entry = sketchChain(appState.database.sketches.sk)[0] as any;
    const state = appState.database.sketches.sk.instances![entry.instance_key].state;

    // Input is seeded from its schema default; the live output is NOT.
    expect(state.amplitude).toBe(1);
    expect('output' in state).toBe(false);
  });
});
