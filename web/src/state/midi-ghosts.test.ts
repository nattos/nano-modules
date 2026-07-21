/**
 * Ghost-device adopt/alias core: adoptGhost keeps the ghost uuid as the new
 * instance id, addKnownAs records alias uuids, knownDeviceIds spans ids ∪
 * aliases (deleted included), and the external-scalar push resolves aliased
 * wire refs to the canonical device's values — all with ZERO sketch edits.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { midiController } from './midi-controller';
import { MFT_TEMPLATE_ID } from '../midi/drivers/mft';
import { libraryKnownIds } from '../midi/midi-types';
import { buildExternalScalars } from '../midi/wire-lowering';
import type { DeviceInstance } from '../midi/midi-types';
import type { Sketch } from '../sketch-types';

function seedFork(id: string, extra: Partial<DeviceInstance> = {}): void {
  runInAction(() => {
    appState.local.midi.library.push({
      id, templateId: MFT_TEMPLATE_ID, parentId: MFT_TEMPLATE_ID,
      forkedAt: 0, name: `Fork ${id}`, config: {}, identities: [], updatedAt: 0,
      ...extra,
    });
  });
}

afterEach(() => {
  runInAction(() => {
    appState.local.midi.library = [];
    for (const k of Object.keys(appState.database.sketches)) delete appState.database.sketches[k];
  });
});

describe('adoptGhost', () => {
  it('creates a library instance whose id IS the ghost uuid', () => {
    const inst = midiController.adoptGhost('ghost-uuid-1', MFT_TEMPLATE_ID);
    expect(inst.id).toBe('ghost-uuid-1');
    expect(inst.templateId).toBe(MFT_TEMPLATE_ID);
    expect(appState.local.midi.library.map(i => i.id)).toContain('ghost-uuid-1');
    // Idempotent: adopting again returns the existing instance.
    expect(midiController.adoptGhost('ghost-uuid-1', MFT_TEMPLATE_ID)).toBe(
      appState.local.midi.library.find(i => i.id === 'ghost-uuid-1'));
  });
});

describe('addKnownAs', () => {
  it('records the alias once, never self-aliases', () => {
    seedFork('mine');
    midiController.addKnownAs('mine', 'ghost-uuid-2');
    midiController.addKnownAs('mine', 'ghost-uuid-2');   // dedupe
    midiController.addKnownAs('mine', 'mine');           // self — ignored
    expect(midiController.instance('mine')!.knownAs).toEqual(['ghost-uuid-2']);
  });
});

describe('knownDeviceIds / libraryKnownIds', () => {
  it('spans ids and aliases; deleted instances stay known', () => {
    seedFork('a', { knownAs: ['ghost-x'] });
    seedFork('b', { deleted: true });
    const known = libraryKnownIds(appState.local.midi.library);
    expect([...known].sort()).toEqual(['a', 'b', 'ghost-x']);
    expect([...midiController.knownDeviceIds()].sort()).toEqual(['a', 'b', 'ghost-x']);
  });
});

describe('buildExternalScalars alias resolution', () => {
  it('aliased wire refs read the canonical device values under the wire key', () => {
    const sketch: Sketch = {
      anchor: null,
      chain: [{ type: 'module', module_type: 'util.dashboard', instance_key: 'da@0' }],
      wires: [
        { id: 'w1', src: { instanceKey: 'midi:ghost-x', field: 'b0/e05/turn' },
          dest: { instanceKey: 'da@0', field: 'knob_3' }, combine: 'add' },
      ],
    };
    const values = (id: string) =>
      id === 'canon' ? new Map([['b0/e05/turn', 0.42]]) : new Map<string, number>();
    // Without resolution the ghost ref is dormant (no values under its id).
    expect(buildExternalScalars({ s: sketch }, values)).toBe('{}');
    // With alias resolution the entry keeps the WIRE's uuid, values from canon.
    const resolved = buildExternalScalars(
      { s: sketch }, values, id => (id === 'ghost-x' ? 'canon' : id));
    expect(JSON.parse(resolved)).toEqual({ 'midi:ghost-x': { 'b0/e05/turn': 0.42 } });
  });
});
