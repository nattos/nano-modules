/**
 * User settings — small singleton persisted to IndexedDB.
 *
 * Lives in `appState.local.userSettings` and is NOT touched by
 * `appController.mutate`. Saves are scheduled explicitly from the controller
 * methods that mutate the settings — never via a MobX reaction.
 *
 * This module exposes the pure load/save primitives. The debouncing and
 * change-detection live in the controller.
 *
 * In the desktop app they are the `settings` section of
 * `Settings/remote-control.json` (settings-files.ts) — the only app that runs
 * these surfaces — and an external edit of it is applied live through
 * `watchUserSettings`.
 */

import { toJS } from 'mobx';
import type { UserSettings } from './types';
import { idbGet, idbPut, STORE_SETTINGS } from './idb-store';
import {
  readSection, settingsFilesAvailable, SETTINGS_FILES, watchSection, writeSection,
} from './settings-files';

export function defaultUserSettings(): UserSettings {
  return {
    ideLeftPanelWidth: 320,
    ideLeftTab: 'explorer',
    selectedProjectId: null,
    paused: false,
    activeTab: 'edit',
    editingSketchId: null,
    targetFps: 60,
    editLeftPanelWidth: 320,
    sketchCanvasOpen: false,
    sidechannelNames: {},
    instanceNames: {},
    appMode: 'effect-dev',
    barrelRemoteEnabled: true,
    lastLiveInstanceKey: null,
    lastCompositionBarrelIds: [],
    deviceFilters: { connected: true, disconnected: true, unrecognized: true, templates: true, deleted: false },
    devicesMonitorHeight: 180,
    midiOfferedPorts: [],
  };
}

const SETTINGS_KEY = 'settings';

interface SettingsRecord {
  id: string;
  settings: UserSettings;
}

/** Defaults under a stored (possibly partial, possibly hand-edited) record. */
export function mergeUserSettings(stored: Partial<UserSettings> | null | undefined): UserSettings {
  const defaults = defaultUserSettings();
  if (!stored || typeof stored !== 'object') return defaults;
  // Merge against defaults so newly-added keys get sensible values. The
  // top-level spread is shallow — nested option bags need their own merge
  // or a persisted copy from before a new key hides it forever.
  return {
    ...defaults,
    ...stored,
    deviceFilters: { ...defaults.deviceFilters, ...stored.deviceFilters },
  };
}

const FILE = SETTINGS_FILES.remoteControl;
const SECTION = 'settings';

export async function loadUserSettings(): Promise<UserSettings> {
  try {
    if (settingsFilesAvailable()) return mergeUserSettings(readSection(FILE, SECTION));
    const record = await idbGet<SettingsRecord>(STORE_SETTINGS, SETTINGS_KEY);
    return mergeUserSettings(record?.settings);
  } catch (err) {
    console.warn('[user-settings] load failed, using defaults', err);
    return defaultUserSettings();
  }
}

export async function saveUserSettings(settings: UserSettings): Promise<void> {
  const safe = toJS(settings);
  if (settingsFilesAvailable()) {
    writeSection(FILE, SECTION, safe);
    return;
  }
  await idbPut(STORE_SETTINGS, { id: SETTINGS_KEY, settings: safe } satisfies SettingsRecord);
}

/** Desktop only: `cb` with the merged settings whenever the file's `settings`
 *  section is edited from outside. A no-op in the browser. */
export function watchUserSettings(cb: (settings: UserSettings) => void): () => void {
  return watchSection<Partial<UserSettings>>(FILE, SECTION, (v) => cb(mergeUserSettings(v)));
}
