import { describe, it, expect } from 'vitest';
import { toJS } from 'mobx';
import { store } from './store';
import { emptyComposition, type Composition } from '../model/composition';
import { deserializeComposition, serializeComposition, type WorkspaceBackend } from '../workspace/backend';
import { ALL_MIGRATION_IDS } from '../../../state/effect-migrations';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

/**
 * A document saved and opened again is the SAME document: its routes, its
 * placed lights and displays, and its record of effect migrations (an
 * arrangement's devices carry no version — re-running a migration would
 * rewrite already-current state: an LFO's rate ×10 on every open).
 */
describe('open an arrangement from a file', () => {
  it('keeps devices, routes and effect state across save → open', async () => {
    const comp: Composition = emptyComposition();
    comp.migrations = [...ALL_MIGRATION_IDS];
    comp.tracks = [...comp.tracks, {
      id: 't1', name: 'T', kind: 'track', parentId: null, automation: [], clips: [],
      sketch: { devices: [{ id: 'lfo', moduleType: 'mod.source.lfo', name: 'LFO', capabilities: [], state: { rate: 2 } }] },
    } as unknown as Composition['tracks'][number]];
    comp.devices = [
      { id: 'p1', kind: 'light', deviceId: 'rig-1', layout: { s1: { x: 0.1, y: 0, w: 0.02, h: 1 } } },
      { id: 'd1', kind: 'display', deviceId: 'display.1', fit: 'stretch' },
    ];
    comp.routes = [{ id: 'r1', src: { kind: 'port', trackId: 't1', portId: '__out__' },
      dest: { kind: 'device', placementId: 'd1' } }];
    const file = serializeComposition(comp);
    const backend = { read: async () => deserializeComposition(file) } as unknown as WorkspaceBackend;

    for (let i = 0; i < 2; i++) {  // open twice: nothing compounds
      await store.openArrangement(backend, 'show');
      const now = toJS(store.composition);
      const lfo = now.tracks.find((t) => t.id === 't1')!.sketch.devices[0];
      expect(lfo.state?.rate).toBe(2);
      expect(now.devices).toEqual(comp.devices);
      expect(now.routes).toEqual(comp.routes);
    }
  });
});
