/**
 * MIDI device library persistence — pure IndexedDB load/save primitives, one
 * record per `DeviceInstance` (keyed by uuid, soft-deleted rows included).
 *
 * Mirrors user-settings.ts: this module has no scheduling or change detection;
 * saves are invoked explicitly from the mutating actions in
 * `state/midi-controller.ts` — never via a MobX reaction.
 *
 * The desktop app keeps the whole library as ONE array in
 * `Settings/midi-devices.json` (settings-files.ts) — the same array the bridge
 * carries as /global/midi_devices, and the same file the native plugin reads
 * and writes. Saves UPSERT into the file as it is on disk, so a row the plugin
 * wrote (from another editor) is never dropped, and the file can never be
 * emptied by a save. An external edit reloads live (`watchDeviceLibrary`).
 */

import { toJS } from 'mobx';
import type { DeviceInstance } from '../midi/midi-types';
import { idbDelete, idbGetAll, idbPut, STORE_MIDI_DEVICES } from './idb-store';
import {
  readSettings, settingsFilesAvailable, SETTINGS_FILES, watchSettings, writeSettings,
} from './settings-files';

const FILE = SETTINGS_FILES.midiDevices;

/** The well-formed rows of a stored/pushed library, oldest fork first. */
export function validDeviceRows(doc: unknown): DeviceInstance[] {
  if (!Array.isArray(doc)) return [];
  return doc
    .filter((r): r is DeviceInstance =>
      !!r && typeof r === 'object' &&
      typeof (r as { id?: unknown }).id === 'string' &&
      typeof (r as { templateId?: unknown }).templateId === 'string')
    .map((r) => ({ ...r, identities: r.identities ?? [], config: r.config ?? {} }))
    .sort((a, b) => (a.forkedAt ?? 0) - (b.forkedAt ?? 0));
}

export async function loadDeviceLibrary(): Promise<DeviceInstance[]> {
  if (settingsFilesAvailable()) return validDeviceRows(readSettings(FILE));
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
  if (settingsFilesAvailable()) {
    const onDisk = readSettings(FILE);
    const rows = Array.isArray(onDisk) ? [...onDisk] : [];
    const row = toJS(instance);
    const i = rows.findIndex((r) => r && r.id === instance.id);
    if (i >= 0) rows[i] = row; else rows.push(row);
    writeSettings(FILE, rows);
    return;
  }
  await idbPut(STORE_MIDI_DEVICES, toJS(instance));
}

/** Hard removal (soft delete is just a flag save). */
export async function purgeDeviceInstance(id: string): Promise<void> {
  if (settingsFilesAvailable()) {
    const onDisk = readSettings(FILE);
    if (!Array.isArray(onDisk)) return;
    const rows = onDisk.filter((r) => r && r.id !== id);
    // Never write an empty library over a non-empty one: the plugin treats
    // the file as the library, and `[]` is what a fresh profile looks like.
    if (rows.length > 0) writeSettings(FILE, rows);
    return;
  }
  await idbDelete(STORE_MIDI_DEVICES, id);
}

/** Desktop only: `cb` with the library whenever midi-devices.json is changed
 *  by someone else (the plugin, a person, an agent). A no-op in the browser. */
export function watchDeviceLibrary(cb: (rows: DeviceInstance[]) => void): () => void {
  return watchSettings(FILE, (doc) => { if (Array.isArray(doc)) cb(validDeviceRows(doc)); });
}
