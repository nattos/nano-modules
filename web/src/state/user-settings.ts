/**
 * User settings — small singleton persisted to IndexedDB.
 *
 * Lives in `appState.local.userSettings` and is NOT touched by
 * `appController.mutate`. Changes are persisted via a debounced autorun.
 *
 * Why split from `database`? Splitter drags, scroll positions, last-tab
 * selections must not pollute the undo history.
 */

import { autorun, toJS } from 'mobx';
import { appState } from './app-state';
import { idbGet, idbPut, STORE_SETTINGS } from './idb-store';
import type { UserSettings } from './types';

export function defaultUserSettings(): UserSettings {
  return {
    ideLeftPanelWidth: 320,
    ideLeftTab: 'explorer',
    selectedProjectId: null,
    scrollPositions: {},
    paused: false,
  };
}

const SETTINGS_KEY = 'settings';

interface SettingsRecord {
  id: string;
  settings: UserSettings;
}

export async function loadUserSettings(): Promise<UserSettings> {
  const defaults = defaultUserSettings();
  try {
    const record = await idbGet<SettingsRecord>(STORE_SETTINGS, SETTINGS_KEY);
    if (!record?.settings) return defaults;
    // Merge against defaults so newly-added keys get sensible values.
    return { ...defaults, ...record.settings };
  } catch (err) {
    console.warn('[user-settings] load failed, using defaults', err);
    return defaults;
  }
}

/**
 * Subscribe a debounced autorun that writes user settings to IDB.
 * Returns a dispose function.
 */
export function subscribeUserSettingsAutosave(debounceMs = 300): () => void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const dispose = autorun(() => {
    // toJS subscribes to every nested observable.
    const snapshot = toJS(appState.local.userSettings);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      idbPut(STORE_SETTINGS, { id: SETTINGS_KEY, settings: snapshot } satisfies SettingsRecord)
        .catch(err => console.warn('[user-settings] save failed', err));
    }, debounceMs);
  });
  return () => {
    dispose();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
}
