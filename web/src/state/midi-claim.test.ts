/**
 * MidiController.claimPort — define-mode port binding semantics: templates
 * fork, existing instances claim in place (wires must follow the hardware),
 * and a claim revokes the same platform port id from every other instance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { midiController } from './midi-controller';
import { MFT_TEMPLATE_ID } from '../midi/drivers/mft';
import type { DeviceInstance } from '../midi/midi-types';

const TWISTER = { name: 'Midi Fighter Twister', manufacturer: 'DJ Tech Tools', webPortId: 'p-1' };

function seedFork(id: string, identities: DeviceInstance['identities'] = []): void {
  runInAction(() => {
    appState.local.midi.library.push({
      id, templateId: MFT_TEMPLATE_ID, parentId: MFT_TEMPLATE_ID,
      forkedAt: 0, name: `Fork ${id}`, config: {}, identities, updatedAt: 0,
    });
  });
}

afterEach(() => {
  runInAction(() => { appState.local.midi.library = []; });
});

describe('claimPort', () => {
  it('claims directly on an existing instance — no fork, wires keep working', () => {
    seedFork('a');
    const claimed = midiController.claimPort('a', { ...TWISTER });
    expect(claimed.id).toBe('a');
    expect(appState.local.midi.library).toHaveLength(1);
    expect(claimed.identities).toEqual([TWISTER]);
  });

  it('forks a template first (lazy-fork rule)', () => {
    const claimed = midiController.claimPort(MFT_TEMPLATE_ID, { ...TWISTER });
    expect(claimed.templateId).toBe(MFT_TEMPLATE_ID);
    expect(claimed.id).not.toBe(MFT_TEMPLATE_ID);
    expect(claimed.identities).toEqual([TWISTER]);
    expect(appState.local.midi.library).toHaveLength(1);
  });

  it('revokes the same port id from other instances (exclusive claim)', () => {
    seedFork('old', [{ ...TWISTER }]);
    seedFork('new');
    const claimed = midiController.claimPort('new', { ...TWISTER });
    expect(claimed.identities).toEqual([TWISTER]);
    const old = appState.local.midi.library.find(i => i.id === 'old')!;
    expect(old.identities).toEqual([]);
  });

  it('keeps tuple-only claims on other instances (a second identical unit)', () => {
    const otherUnit = { name: TWISTER.name, manufacturer: TWISTER.manufacturer, webPortId: 'p-2' };
    seedFork('unit-b', [otherUnit]);
    seedFork('unit-a');
    midiController.claimPort('unit-a', { ...TWISTER });
    const b = appState.local.midi.library.find(i => i.id === 'unit-b')!;
    expect(b.identities).toEqual([otherUnit]);
  });

  it('re-claiming refreshes the tuple identity in place instead of stacking', () => {
    seedFork('a', [{ name: TWISTER.name, manufacturer: TWISTER.manufacturer, webPortId: 'stale' }]);
    const claimed = midiController.claimPort('a', { ...TWISTER });
    expect(claimed.identities).toEqual([TWISTER]);
  });
});
