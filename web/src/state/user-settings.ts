/**
 * User settings — small singleton persisted to IndexedDB.
 *
 * Lives in `appState.local.userSettings` and is NOT touched by
 * `appController.mutate`. Saves are scheduled explicitly from the controller
 * methods that mutate the settings — never via a MobX reaction.
 *
 * This module exposes the pure load/save primitives. The debouncing and
 * change-detection live in the controller.
 */

import { toJS } from 'mobx';
import type { UserSettings } from './types';
import { idbGet, idbPut, STORE_SETTINGS } from './idb-store';

export function defaultUserSettings(): UserSettings {
  return {
    ideLeftPanelWidth: 320,
    ideLeftTab: 'explorer',
    selectedProjectId: null,
    scrollPositions: {},
    paused: false,
    activeTab: 'edit',
    editingSketchId: null,
    targetFps: 60,
    editLeftPanelWidth: 320,
    sidechannelNames: {},
    instanceNames: {},
    appMode: 'effect-dev',
    barrelRemoteEnabled: true,
    lastLiveInstanceKey: null,
    lastCompositionBarrelIds: [],
    deviceFilters: { connected: true, disconnected: true, templates: true, deleted: false },
    devicesMonitorHeight: 180,
    midiOfferedPorts: [],
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

export async function saveUserSettings(settings: UserSettings): Promise<void> {
  const safe = toJS(settings);
  await idbPut(STORE_SETTINGS, { id: SETTINGS_KEY, settings: safe } satisfies SettingsRecord);
}
