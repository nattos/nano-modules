/**
 * remapDeadMidiWires — composition-wide dead `midi:` wire repair. Loaded
 * sketches rewrite in one mutate; LIVE barrel instances the editor hasn't
 * loaded are fetched + patched over the bridge (setBarrelSketchOps), so a
 * Live-mode remap really covers ALL sketches, not just the edited one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { Sketch } from '../sketch-types';

const GHOST = 'ghost-dev-uuid';
const DEV = 'real-dev-uuid';

const sketchWith = (wires: Sketch['wires']): Sketch => ({
  anchor: null,
  chain: [{ type: 'module', module_type: 'util.dashboard', instance_key: 'da@0' }],
  instances: { 'da@0': { module_type: 'util.dashboard', state: {} } },
  wires,
});

afterEach(() => {
  appController.setBarrelSketchOps(null);
  runInAction(() => {
    for (const k of Object.keys(appState.database.sketches)) delete appState.database.sketches[k];
    appState.local.barrelInstances = [];
  });
});

describe('remapDeadMidiWires', () => {
  it('rewrites loaded sketches AND unloaded live barrel instances', async () => {
    runInAction(() => {
      appState.database.sketches['loaded'] = sketchWith([
        { id: 'w1', src: { instanceKey: `midi:${GHOST}`, field: 'b0/e05/turn' },
          dest: { instanceKey: 'da@0', field: 'knob_3' }, combine: 'add', mod: { scale: 0.5 } },
        { id: 'w2', src: { instanceKey: `midi:${DEV}`, field: 'b0/e01/turn' },
          dest: { instanceKey: 'da@0', field: 'knob_1' }, combine: 'add' },
      ]);
      appState.local.barrelInstances = [
        { key: 'loaded' }, { key: 'remote-live' }, { key: 'remote-offline' },
      ] as any;
    });
    const pushed: Record<string, Sketch> = {};
    appController.setBarrelSketchOps({
      fetch: async (key: string) => {
        if (key === 'remote-live') {
          return sketchWith([
            { id: 'r1', src: { instanceKey: `midi:${GHOST}`, field: 'b1/e08/press' },
              dest: { instanceKey: 'da@0', field: 'knob_7' }, combine: 'add' },
          ]);
        }
        return null;   // offline placeholder: fetch times out → null
      },
      push: (key: string, sketch: Sketch) => { pushed[key] = sketch; },
    });

    const res = await appController.remapDeadMidiWires(new Set([DEV]), `midi:${DEV}`);
    expect(res).toEqual({ wires: 2, sketches: 2 });

    // Loaded sketch: dead wire re-pointed (field + mod kept), live wire untouched.
    const loaded = appState.database.sketches['loaded']!;
    expect(loaded.wires![0].src).toEqual({ instanceKey: `midi:${DEV}`, field: 'b0/e05/turn' });
    expect(loaded.wires![0].mod).toEqual({ scale: 0.5 });
    expect(loaded.wires![1].src.instanceKey).toBe(`midi:${DEV}`);

    // Remote live instance: fetched, rewritten, pushed back over the bridge.
    expect(Object.keys(pushed)).toEqual(['remote-live']);
    expect(pushed['remote-live'].wires![0].src)
      .toEqual({ instanceKey: `midi:${DEV}`, field: 'b1/e08/press' });
    // Offline placeholder: fetch resolved null → skipped, nothing pushed.
    expect(pushed['remote-offline']).toBeUndefined();
  });

  it('is a no-op (no pushes, no mutate) when every midi wire is live', async () => {
    runInAction(() => {
      appState.database.sketches['loaded'] = sketchWith([
        { id: 'w1', src: { instanceKey: `midi:${DEV}`, field: 'b0/e05/turn' },
          dest: { instanceKey: 'da@0', field: 'knob_3' }, combine: 'add' },
      ]);
      appState.local.barrelInstances = [{ key: 'loaded' }] as any;
    });
    let fetches = 0;
    appController.setBarrelSketchOps({
      fetch: async () => { fetches++; return null; },
      push: () => { throw new Error('must not push'); },
    });
    const res = await appController.remapDeadMidiWires(new Set([DEV]), `midi:${DEV}`);
    expect(res).toEqual({ wires: 0, sketches: 0 });
    expect(fetches).toBe(0);   // 'loaded' is in the DB — never bridge-fetched
  });
});
