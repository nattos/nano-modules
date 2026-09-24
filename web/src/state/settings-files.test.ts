/**
 * The desktop settings folder (settings-files.ts) and the stores built on it,
 * against a REAL temp directory — the point is the file behaviour: atomic
 * writes, no echo of our own saves, external edits picked up, bad JSON
 * ignored. The Electron renderer is simulated by exposing node's `require`
 * and the preload's `nanoSettingsDir`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkForChange, formatSettings, readSection, readSettings, resetSettingsFilesForTest,
  settingsFilesAvailable, watchSection, watchSettings, WATCH_DEBOUNCE_MS, writeSection, writeSettings,
} from './settings-files';
import { loadUserSettings, saveUserSettings, defaultUserSettings } from './user-settings';
import { loadDeviceLibrary, purgeDeviceInstance, saveDeviceInstance } from './midi-device-store';

const nodeRequire = createRequire(import.meta.url);
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nano-settings-'));
  (globalThis as any).require = nodeRequire;
  (globalThis as any).nanoSettingsDir = dir;
});

afterEach(() => {
  resetSettingsFilesForTest();
  delete (globalThis as any).require;
  delete (globalThis as any).nanoSettingsDir;
  rmSync(dir, { recursive: true, force: true });
});

const onDisk = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
/** Someone else writing the file: a plain write, not through the module. */
const externalWrite = (name: string, text: string) => writeFileSync(join(dir, name), text);

describe('settings files', () => {
  it('is only on in the desktop app', () => {
    expect(settingsFilesAvailable()).toBe(true);
    delete (globalThis as any).nanoSettingsDir;
    expect(settingsFilesAvailable()).toBe(false);
  });

  it('writes atomically, pretty-printed, and skips unchanged writes', () => {
    expect(writeSettings('a.json', { x: 1 })).toBe(true);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('{\n  "x": 1\n}\n');
    expect(existsSync(join(dir, 'a.json.tmp'))).toBe(false);
    expect(writeSettings('a.json', { x: 1 })).toBe(false);
  });

  it('formats exactly as the plugin does (settings_file.h formatJson)', () => {
    // Pinned by native/tests/test_settings_file.cpp with the same document.
    expect(formatSettings({ zeta: [1, 2], alpha: {}, list: [], s: 'x' })).toBe(
      '{\n  "zeta": [\n    1,\n    2\n  ],\n  "alpha": {},\n  "list": [],\n  "s": "x"\n}\n');
  });

  it('writes one section and keeps the others, including ones it does not know', () => {
    externalWrite('s.json', JSON.stringify({ other: { keep: true }, fromAgent: 7 }));
    writeSection('s.json', 'layout', { w: 300 });
    expect(onDisk('s.json')).toEqual({ other: { keep: true }, fromAgent: 7, layout: { w: 300 } });
    expect(readSection('s.json', 'layout')).toEqual({ w: 300 });
    writeSection('s.json', 'layout', undefined);
    expect(onDisk('s.json')).toEqual({ other: { keep: true }, fromAgent: 7 });
  });

  it('never reports our own write, always reports an external one', () => {
    const seen: unknown[] = [];
    watchSettings('w.json', (doc) => seen.push(doc));
    writeSettings('w.json', { v: 1 });
    checkForChange('w.json');
    expect(seen).toEqual([]);
    externalWrite('w.json', '{"v": 2}');
    checkForChange('w.json');
    checkForChange('w.json');   // the same content again is not a change
    expect(seen).toEqual([{ v: 2 }]);
  });

  it('ignores invalid JSON and keeps the current values', () => {
    writeSettings('b.json', { v: 1 });
    const seen: unknown[] = [];
    watchSettings('b.json', (doc) => seen.push(doc));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    externalWrite('b.json', '{ not json');
    checkForChange('b.json');
    expect(seen).toEqual([]);
    expect(readSettings('b.json')).toEqual({ v: 1 });
    warn.mockRestore();
  });

  it('a section watcher fires only when its own section changed', () => {
    writeSettings('c.json', { layout: { w: 1 }, workspace: { path: '/a' } });
    const layouts: unknown[] = [];
    watchSection('c.json', 'layout', (v) => layouts.push(v));
    externalWrite('c.json', JSON.stringify({ layout: { w: 1 }, workspace: { path: '/b' } }));
    checkForChange('c.json');
    expect(layouts).toEqual([]);
    externalWrite('c.json', JSON.stringify({ layout: { w: 2 }, workspace: { path: '/b' } }));
    checkForChange('c.json');
    expect(layouts).toEqual([{ w: 2 }]);
  });

  it('watches the folder for real, surviving the rename a save does', async () => {
    const seen: any[] = [];
    watchSettings('live.json', (doc) => seen.push(doc));
    writeSettings('live.json', { n: 0 });   // replaces the inode
    externalWrite('live.json.tmp', '{"n": 1}');
    nodeRequire('fs').renameSync(join(dir, 'live.json.tmp'), join(dir, 'live.json'));
    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS));
    }
    expect(seen).toEqual([{ n: 1 }]);
  });
});

describe('stores on settings files', () => {
  it('user settings live in the settings section of remote-control.json', async () => {
    const s = { ...defaultUserSettings(), targetFps: 144 };
    await saveUserSettings(s);
    expect(onDisk('remote-control.json').settings.targetFps).toBe(144);
    // A hand edit with a missing nested key still merges with the defaults.
    externalWrite('remote-control.json', JSON.stringify({ settings: { targetFps: 30, deviceFilters: { deleted: true } } }));
    const loaded = await loadUserSettings();
    expect(loaded.targetFps).toBe(30);
    expect(loaded.deviceFilters).toEqual({ ...defaultUserSettings().deviceFilters, deleted: true });
    expect(loaded.editLeftPanelWidth).toBe(defaultUserSettings().editLeftPanelWidth);
  });

  it('the MIDI library upserts into the file and is never emptied by a save', async () => {
    // A row the plugin wrote (from another editor) that this app hasn't seen.
    externalWrite('midi-devices.json', JSON.stringify([
      { id: 'plugin-row', templateId: 't', forkedAt: 1, identities: [], config: {} },
    ]));
    await saveDeviceInstance({ id: 'mine', templateId: 't', forkedAt: 2, identities: [], config: {} } as any);
    expect(onDisk('midi-devices.json').map((r: any) => r.id)).toEqual(['plugin-row', 'mine']);
    expect((await loadDeviceLibrary()).map((r) => r.id)).toEqual(['plugin-row', 'mine']);

    await purgeDeviceInstance('plugin-row');
    await purgeDeviceInstance('mine');   // would empty it: refused
    expect(onDisk('midi-devices.json').map((r: any) => r.id)).toEqual(['mine']);
  });

  it('library paths are rows of library-paths.json, rebuilt as handles, reloaded on edit', async () => {
    vi.resetModules();
    const { mkdirSync } = nodeRequire('fs');
    const footage = join(dir, 'Footage');
    mkdirSync(footage);
    externalWrite('library-paths.json', JSON.stringify([
      { id: 'web-uuid', label: 'Footage', absolutePath: footage, addedAt: 5 },
      { label: 'junk row' },
    ]));
    const sf = await import('./settings-files');
    const { libraryPaths } = await import('./library-paths');
    await libraryPaths.ensureLoaded();
    expect(libraryPaths.paths.map((p) => p.id)).toEqual(['web-uuid']);
    expect(libraryPaths.get('web-uuid')?.handle?.kind).toBe('directory');

    await libraryPaths.addAbsolute(dir, 'Root');
    const rows = onDisk('library-paths.json');
    expect(rows.map((r: any) => r.label)).toEqual(['Footage', 'Root']);
    expect(Object.keys(rows[0])).toEqual(['id', 'label', 'absolutePath', 'addedAt']);

    // An agent drops a row: the list follows, and listeners hear about it.
    let heard = 0;
    libraryPaths.onExternalChange(() => { heard++; });
    externalWrite('library-paths.json', JSON.stringify([rows[1]]));
    sf.checkForChange('library-paths.json');
    await vi.waitFor(() => expect(heard).toBe(1));
    expect(libraryPaths.paths.map((p) => p.label)).toEqual(['Root']);
    sf.resetSettingsFilesForTest();
  });
});
