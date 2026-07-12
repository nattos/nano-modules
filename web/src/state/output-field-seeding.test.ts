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
  appController.clearBarrelPusher();
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

// A UI-only help slot (schema `type: 'help'`) whose default is a large markdown
// string. Its value is never read from `state` (default = schema, overrides =
// the instance `help` map), yet it used to be seeded into every instance and
// then rode every barrel config blob — which Resolume re-broadcasts on each
// clip connect/disconnect. It must be kept out of `state` entirely.
const HELP_PLUGIN: PluginInfo = {
  id: 'fx.demo',
  key: 'fx.demo',
  version: '1',
  params: [{ index: 0, name: 'amount', type: 10, defaultValue: 0.5, min: 0, max: 1 }],
  io: [],
  schema: {
    amount: { type: 'float', default: 0.5, min: 0, max: 1, io: 5 /* PrimaryInput */ },
    intro: { type: 'help', default: '## Demo\nA long help paragraph baked into the schema.' },
  },
} as any;

describe('help-slot fields stay out of persisted state', () => {
  it('does not seed a help field into a new instance state', () => {
    runInAction(() => {
      appState.local.plugins = [HELP_PLUGIN];
      appState.database.sketches = {
        sk: { anchor: null, chain: [], instances: {} },
      } as any;
    });

    appController.addEffectToChain('sk', 0, 0, 'fx.demo');

    const entry = sketchChain(appState.database.sketches.sk)[0] as any;
    const state = appState.database.sketches.sk.instances![entry.instance_key].state;

    expect(state.amount).toBe(0.5);       // real input still seeded
    expect('intro' in state).toBe(false); // help markdown never baked in
  });

  it('prunes help fields already baked into existing instance state once schemas arrive', () => {
    // A legacy instance that carried the help markdown in its state (as older
    // seeding produced). Plugins start empty so the sync counts as a change.
    runInAction(() => {
      appState.local.plugins = [];
      appState.database.sketches = {
        sk: {
          anchor: null, chain: [], wires: [],
          instances: {
            'fx.demo@1': {
              module_type: 'fx.demo',
              state: { amount: 0.5, intro: '## Demo\nStale copy of the help text.' },
            },
          },
        },
      } as any;
    });

    // Schemas arrive → the pluginsChanged seam runs the prune.
    appController.syncFromRemoteState({ plugins: [HELP_PLUGIN], sketches: {} } as any);

    const state = appState.database.sketches.sk.instances!['fx.demo@1'].state;
    expect('intro' in state).toBe(false); // dead weight dropped
    expect(state.amount).toBe(0.5);       // real value untouched
  });

  it('strips help fields from the sketch pushed to the barrel, without mutating the DB', () => {
    // The barrel bakes whatever it receives into its re-broadcast config blob,
    // and the barrel can mirror a fat sketch back in AFTER the one-shot DB
    // prune — so the push path must strip help fields regardless of DB state.
    runInAction(() => {
      appState.local.plugins = [HELP_PLUGIN];
      appState.database.sketches = {
        sk: {
          anchor: null, chain: [], wires: [],
          instances: {
            'fx.demo@1': {
              module_type: 'fx.demo',
              state: { amount: 0.5, intro: '## Demo\nFat help still in the DB.' },
            },
          },
        },
      } as any;
    });

    let pushed: any = null;
    appController.setBarrelPusher('sk', (s) => { pushed = s; });
    // Any committed mutation on the barrel-tracked sketch fires the push.
    appController.addEffectToChain('sk', 0, 0, 'fx.demo');

    expect(pushed).toBeTruthy();
    const pushedState = pushed.instances['fx.demo@1'].state;
    expect('intro' in pushedState).toBe(false); // stripped from what the barrel sees
    expect(pushedState.amount).toBe(0.5);

    // The push path is copy-only — the DB copy is untouched (the DB prune,
    // tested above, is what cleans persistence).
    const dbState = appState.database.sketches.sk.instances!['fx.demo@1'].state;
    expect('intro' in dbState).toBe(true);
  });

  // control.barrel_macros' real shape: ONE help field + 16 pure outputs +
  // textures — i.e. nothing authorable at all. Its legacy `params` list carries
  // the help field too, and the params fallback loop only filtered OUTPUTS, so
  // it re-added `intro` after the schema loop had skipped it. Defaults came out
  // as `{intro: 0}` instead of `{}`, which made defaultStateForPlugin
  // non-idempotent with pruneHelpFieldState: every mirror-in seeded `intro`
  // (backfillEmptyInstanceStates) and then stripped it (prune) — two no-op
  // mutations, each restamping lastModified, defeating the push dedup and
  // driving a push -> echo -> refetch -> mirror-in loop that replaced the whole
  // sketch ~70x/sec. Any edit racing an in-flight refetch was silently reverted:
  // the user saw edits "stick" only by chance.
  const MACROS_PLUGIN: PluginInfo = {
    id: 'control.barrel_macros',
    key: 'control.barrel_macros',
    version: '1',
    params: [
      { index: 0, name: 'intro', type: 10, defaultValue: 0, min: 0, max: 1 },
      { index: 1, name: 'macro_0', type: 10, defaultValue: 0, min: 0, max: 1 },
    ],
    io: [],
    schema: {
      intro: { type: 'help', default: '## Barrel Macros\nHelp text.' },
      macro_0: { type: 'float', default: 0, min: 0, max: 1, io: 2 /* Output only */ },
      tex_in: { type: 'texture', io: 5 },
      tex_out: { type: 'texture', io: 6 },
    },
  } as any;

  it('an all-help+output effect seeds EMPTY state (help never re-added by params)', () => {
    runInAction(() => {
      appState.local.plugins = [MACROS_PLUGIN];
      appState.database.sketches = {
        sk: { anchor: null, chain: [], instances: {} },
      } as any;
    });

    appController.addEffectToChain('sk', 0, 0, 'control.barrel_macros');

    const entry = sketchChain(appState.database.sketches.sk)[0] as any;
    const state = appState.database.sketches.sk.instances![entry.instance_key].state;

    // Nothing here is authorable, so the defaults must be EMPTY. `intro: 0` —
    // the help field re-added by the params loop — is what armed the loop: it
    // made the seed non-idempotent with the prune that immediately removes it.
    expect('intro' in state).toBe(false);
    expect(state).toEqual({});
  });

  it('slims a barrel instance the moment it is viewed (setBarrelSketch) and pushes slim', () => {
    // Viewing an instance mirrors the barrel's (fat) sketch into the DB via
    // setBarrelSketch; with schemas known, the prune must fire there so the
    // instance clears its re-broadcast fat without needing an explicit edit.
    runInAction(() => { appState.local.plugins = [HELP_PLUGIN]; });

    let pushed: any = null;
    appController.setBarrelPusher('barrel', (s) => { pushed = s; });
    appController.setBarrelSketch('barrel', {
      anchor: null, chain: [], wires: [],
      instances: {
        'fx.demo@1': { module_type: 'fx.demo', state: { amount: 0.5, intro: '## Demo\nFat.' } },
      },
    });

    // Mirror-in triggered the prune: DB slimmed AND the slim sketch was pushed.
    const dbState = appState.database.sketches['barrel'].instances!['fx.demo@1'].state;
    expect('intro' in dbState).toBe(false);
    expect(pushed).toBeTruthy();
    expect('intro' in pushed.instances['fx.demo@1'].state).toBe(false);
    expect(pushed.instances['fx.demo@1'].state.amount).toBe(0.5);
  });
});
