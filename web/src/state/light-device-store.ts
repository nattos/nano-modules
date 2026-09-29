/**
 * Light device library persistence — types and rigs (lights/light-types.ts),
 * one record per row, soft-deleted rows included. Pure load/save primitives:
 * saves are invoked explicitly from light-controller.ts's mutating actions,
 * never from a reaction.
 *
 * The desktop app keeps the whole library as ONE array in
 * `Settings/light-devices.json` (settings-files.ts), upserted into the file as
 * it is on disk (a row written elsewhere is never dropped, and the file is
 * never written empty); an external edit reloads live. The browser uses
 * IndexedDB. Mirrors midi-device-store.ts.
 */

import { toJS } from 'mobx';
import type { LightRow } from '../lights/light-types';
import { idbGetAll, idbPut, STORE_LIGHT_DEVICES } from './idb-store';
import {
  readSettings, settingsFilesAvailable, SETTINGS_FILES, watchSettings, writeSettings,
} from './settings-files';

const FILE = SETTINGS_FILES.lightDevices;

/** The well-formed rows of a stored library, oldest first. A type written
 *  before `vertical` existed is vertical (every bar was). */
export function validLightRows(doc: unknown): LightRow[] {
  if (!Array.isArray(doc)) return [];
  return doc
    .filter((r): r is LightRow => {
      if (!r || typeof r !== 'object') return false;
      const row = r as { id?: unknown; kind?: unknown; slots?: unknown };
      if (typeof row.id !== 'string') return false;
      if (row.kind === 'type') return true;
      return row.kind === 'rig' && Array.isArray(row.slots);
    })
    .map((r) => (r.kind === 'type' && typeof r.vertical !== 'boolean' ? { ...r, vertical: true } : r))
    .sort((a, b) => (a.forkedAt ?? 0) - (b.forkedAt ?? 0));
}

export async function loadLightLibrary(): Promise<LightRow[]> {
  if (settingsFilesAvailable()) return validLightRows(readSettings(FILE));
  try {
    return validLightRows(await idbGetAll<LightRow>(STORE_LIGHT_DEVICES));
  } catch (err) {
    console.warn('[light-device-store] load failed, starting empty', err);
    return [];
  }
}

export async function saveLightRow(row: LightRow): Promise<void> {
  if (settingsFilesAvailable()) {
    const onDisk = readSettings(FILE);
    const rows = Array.isArray(onDisk) ? [...onDisk] : [];
    const plain = toJS(row);
    const i = rows.findIndex((r) => r && r.id === row.id);
    if (i >= 0) rows[i] = plain; else rows.push(plain);
    writeSettings(FILE, rows);
    return;
  }
  await idbPut(STORE_LIGHT_DEVICES, toJS(row));
}

/** Desktop only: `cb` with the library whenever light-devices.json is changed
 *  by someone else. A no-op in the browser. */
export function watchLightLibrary(cb: (rows: LightRow[]) => void): () => void {
  return watchSettings(FILE, (doc) => { if (Array.isArray(doc)) cb(validLightRows(doc)); });
}
