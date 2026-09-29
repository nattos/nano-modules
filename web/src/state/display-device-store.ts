/**
 * Display device library persistence — which screen fills each display slot
 * on this machine (displays/display-types.ts), one record per slot. Pure
 * load/save primitives: saves are invoked explicitly from
 * display-controller.ts's mutating actions, never from a reaction.
 *
 * The desktop app keeps the whole library as ONE array in
 * `Settings/display-devices.json` (settings-files.ts), upserted into the file
 * as it is on disk; an external edit reloads live. The browser uses
 * IndexedDB. Mirrors light-device-store.ts.
 */

import { toJS } from 'mobx';
import { displayOrdinal, type DisplaySlot } from '../displays/display-types';
import { idbGetAll, idbPut, STORE_DISPLAY_DEVICES } from './idb-store';
import {
  readSettings, settingsFilesAvailable, SETTINGS_FILES, watchSettings, writeSettings,
} from './settings-files';

const FILE = SETTINGS_FILES.displayDevices;

/** The well-formed rows of a stored library, in slot order. */
export function validDisplayRows(doc: unknown): DisplaySlot[] {
  if (!Array.isArray(doc)) return [];
  return doc
    .filter((r): r is DisplaySlot => !!r && typeof r === 'object' &&
      (r as { kind?: unknown }).kind === 'display' &&
      typeof (r as { id?: unknown }).id === 'string' && displayOrdinal((r as DisplaySlot).id) > 0 &&
      typeof (r as { name?: unknown }).name === 'string')
    .sort((a, b) => displayOrdinal(a.id) - displayOrdinal(b.id));
}

export async function loadDisplayLibrary(): Promise<DisplaySlot[]> {
  if (settingsFilesAvailable()) return validDisplayRows(readSettings(FILE));
  try {
    return validDisplayRows(await idbGetAll<DisplaySlot>(STORE_DISPLAY_DEVICES));
  } catch (err) {
    console.warn('[display-device-store] load failed, starting empty', err);
    return [];
  }
}

export async function saveDisplayRow(row: DisplaySlot): Promise<void> {
  if (settingsFilesAvailable()) {
    const onDisk = readSettings(FILE);
    const rows = Array.isArray(onDisk) ? [...onDisk] : [];
    const plain = toJS(row);
    const i = rows.findIndex((r) => r && r.id === row.id);
    if (i >= 0) rows[i] = plain; else rows.push(plain);
    writeSettings(FILE, rows);
    return;
  }
  await idbPut(STORE_DISPLAY_DEVICES, toJS(row));
}

/** Desktop only: `cb` with the library whenever display-devices.json is
 *  changed by someone else. A no-op in the browser. */
export function watchDisplayLibrary(cb: (rows: DisplaySlot[]) => void): () => void {
  return watchSettings(FILE, (doc) => { if (Array.isArray(doc)) cb(validDisplayRows(doc)); });
}
