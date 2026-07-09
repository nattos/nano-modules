/**
 * MIDI device library persistence — pure IndexedDB load/save primitives, one
 * record per `DeviceInstance` (keyed by uuid, soft-deleted rows included).
 *
 * Mirrors user-settings.ts: this module has no scheduling or change detection;
 * saves are invoked explicitly from the mutating actions in
 * `state/midi-controller.ts` — never via a MobX reaction.
 */

import { toJS } from 'mobx';
import type { DeviceInstance } from '../midi/midi-types';
import { idbDelete, idbGetAll, idbPut, STORE_MIDI_DEVICES } from './idb-store';

export async function loadDeviceLibrary(): Promise<DeviceInstance[]> {
  try {
    const rows = await idbGetAll<DeviceInstance>(STORE_MIDI_DEVICES);
    // Stable presentation + deterministic tuple-match order.
    return rows.sort((a, b) => a.forkedAt - b.forkedAt);
  } catch (err) {
    console.warn('[midi-device-store] load failed, starting empty', err);
    return [];
  }
}

export async function saveDeviceInstance(instance: DeviceInstance): Promise<void> {
  await idbPut(STORE_MIDI_DEVICES, toJS(instance));
}

/** Hard removal (soft delete is just a flag save). */
export async function purgeDeviceInstance(id: string): Promise<void> {
  await idbDelete(STORE_MIDI_DEVICES, id);
}
