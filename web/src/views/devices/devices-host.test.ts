import { describe, it, expect, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from '../../state/app-state';
import type { DeviceInstance } from '../../midi/midi-types';
import type { Sketch, Wire } from '../../sketch-types';
import { devicesInUse, type DevicesHost } from './devices-host';

/** "in use": library devices a project's wires read (either end; an alias
 *  uuid counts for the device answering to it), plus its timeline rows. */
describe('devicesInUse', () => {
  const inst = (id: string, extra: Partial<DeviceInstance> = {}): DeviceInstance => ({
    id, templateId: 'com.nano.midi.mft', parentId: 'com.nano.midi.mft', forkedAt: 0,
    name: id, config: {}, identities: [], updatedAt: 0, ...extra,
  });
  const wire = (src: string, dest: string): Wire => ({
    id: `${src}->${dest}`,
    src: { instanceKey: src, field: 'b0/e00/turn' },
    dest: { instanceKey: dest, field: dest.startsWith('midi:') ? 'b0/e01/turn' : 'gain' },
  } as Wire);
  const host = (wires: Wire[], included: string[] = []): DevicesHost => ({
    sketches: () => ({ s1: { anchor: null, chain: [], instances: {}, wires } as unknown as Sketch }),
    included: { has: (id: string) => included.includes(id), toggle: () => {} },
  } as unknown as DevicesHost);

  beforeEach(() => {
    runInAction(() => {
      appState.local.midi.library = [
        inst('a'), inst('b', { knownAs: ['ghost-b'] }), inst('c'), inst('d'), inst('gone', { deleted: true }),
      ];
    });
  });

  it('collects wired devices, aliases, and timeline rows', () => {
    const used = devicesInUse(host([
      wire('midi:a', 'fx1'),            // a modulation source
      wire('midi:ghost-b', 'fx2'),      // b, through its knownAs alias
      wire('midi:x', 'midi:c'),         // c, the far end of a control alias
      wire('midi:gone', 'fx3'),         // deleted devices never count
    ], ['d']));
    expect([...used].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is empty for a project with no device wires', () => {
    expect(devicesInUse(host([wire('lfo1', 'fx1')])).size).toBe(0);
  });
});
