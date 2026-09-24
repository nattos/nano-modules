/**
 * Settings as files — the desktop apps' half of the shared settings folder.
 *
 * In Electron every surface keeps its settings in ONE JSON file under
 * `<appData>/Nano Modules/Settings/` (electron/data-root.cjs), and data that
 * several surfaces share gets its own file beside them:
 *
 *   arrangement.json      the NanoModules app      {layout, workspace}
 *   remote-control.json   Remote Control app       {settings, selectedInstance, inputVideo}
 *   plugin.json           the FFGL plugin          (native only — barrel_runtime.cpp)
 *   midi-devices.json     Remote Control + plugin  the MIDI device library, as an array
 *   library-paths.json    arrangement + plugin     [{id, label, absolutePath}]
 *   module-paths.json     everyone                 (electron/module-dirs.cjs)
 *
 * The native plugin reads and writes the same files, by the same rules
 * (native/src/bridge/settings_file.h) — KEEP THE TWO IN STEP:
 *
 *   - Writes are atomic: `<name>.tmp`, then rename. A reader never sees half a
 *     file, and an agent's editor never races a half-written one.
 *   - A write whose bytes equal what we last read or wrote is skipped, and the
 *     watcher ignores content equal to that same last-known content. That is
 *     how our own saves don't echo back as "external" changes.
 *   - External edits apply LIVE: the folder is watched (a rename replaces the
 *     inode, so a per-file watch would go deaf after the first save), and a
 *     changed file is handed to its watchers, which apply it through explicit
 *     actions — never a MobX reaction.
 *   - Invalid JSON is logged and ignored; the current values stay.
 *
 * The browser build has no folder (`settingsFilesAvailable()` is false) and its
 * stores keep IndexedDB.
 */

import { toJS } from 'mobx';
import { nodeRequire } from './paths';

/** The settings folder, or null outside Electron. */
export function settingsDir(): string | null {
  const dir = (globalThis as any).nanoSettingsDir;
  return typeof dir === 'string' && dir ? dir : null;
}

export function settingsFilesAvailable(): boolean {
  return settingsDir() !== null && !!nodeRequire('fs');
}

interface FileState {
  /** Bytes last read from or written to disk; null = none / file absent. */
  bytes: string | null;
  /** The parsed document behind `bytes` (the last GOOD one). */
  doc: any;
}

const files = new Map<string, FileState>();
type Listener = (doc: any, prev: any) => void;
const listeners = new Map<string, Set<Listener>>();
let dirWatcher: { close(): void } | null = null;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounce for a burst of watch events (tmp write + rename, editors' saves). */
export const WATCH_DEBOUNCE_MS = 100;

function fs(): any { return nodeRequire('fs'); }
function pathMod(): any { return nodeRequire('path'); }

function fileOf(name: string): string {
  const dir = settingsDir();
  if (!dir) throw new Error('[settings-files] no settings folder (not running under Electron)');
  return pathMod().join(dir, name);
}

/** Serialize the way every writer does, so equal content is equal bytes. */
export function formatSettings(doc: unknown): string {
  return JSON.stringify(toJS(doc), null, 2) + '\n';
}

function stateOf(name: string): FileState {
  let st = files.get(name);
  if (!st) { st = { bytes: null, doc: null }; files.set(name, st); }
  return st;
}

function readBytes(name: string): string | null {
  try {
    return fs().readFileSync(fileOf(name), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Re-read `name` from disk. Returns the parsed document; on invalid JSON warns
 * and returns the last good one (the current values stay).
 */
export function readSettings<T = any>(name: string): T | null {
  const st = stateOf(name);
  const bytes = readBytes(name);
  if (bytes === null) { st.bytes = null; st.doc = null; return null; }
  if (bytes === st.bytes) return st.doc;
  try {
    st.doc = JSON.parse(bytes);
  } catch (err) {
    console.warn(`[settings-files] ${name}: invalid JSON, keeping the current values`, err);
  }
  st.bytes = bytes;
  return st.doc;
}

/** Atomically replace `name` with `doc`. False when skipped (unchanged). */
export function writeSettings(name: string, doc: unknown): boolean {
  const st = stateOf(name);
  const bytes = formatSettings(doc);
  if (bytes === st.bytes) return false;
  // Same content, formatted by someone else (an agent's editor): still nothing
  // to write — rewriting it would only churn their file.
  if (st.bytes !== null && st.doc !== null && bytes === formatSettings(st.doc)) return false;
  const file = fileOf(name);
  const f = fs();
  f.mkdirSync(pathMod().dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // Record BEFORE the rename lands, so the watch event it raises reads back as
  // our own write.
  st.bytes = bytes;
  st.doc = JSON.parse(bytes);
  f.writeFileSync(tmp, bytes);
  f.renameSync(tmp, file);
  return true;
}

/** One top-level section of a surface's file. */
export function readSection<T = any>(name: string, key: string): T | undefined {
  const doc = readSettings(name);
  return doc && typeof doc === 'object' ? doc[key] : undefined;
}

/** Replace one section, keeping the file's other sections (and any keys a
 *  newer build or a person added) as last read. */
export function writeSection(name: string, key: string, value: unknown): boolean {
  const st = stateOf(name);
  if (st.bytes === null) readSettings(name);
  const base = st.doc && typeof st.doc === 'object' && !Array.isArray(st.doc) ? st.doc : {};
  const next = { ...base };
  if (value === undefined) delete next[key];
  else next[key] = toJS(value);
  return writeSettings(name, next);
}

function ensureWatcher(): void {
  if (dirWatcher) return;
  const dir = settingsDir();
  if (!dir) return;
  const f = fs();
  try {
    f.mkdirSync(dir, { recursive: true });
    dirWatcher = f.watch(dir, (_event: string, filename: string | null) => {
      // No filename (some platforms) → check everything watched.
      const names = filename ? [String(filename)] : [...listeners.keys()];
      for (const n of names) if (listeners.has(n)) schedule(n);
    });
  } catch (err) {
    console.warn('[settings-files] cannot watch the settings folder; external edits apply on restart', err);
  }
}

function schedule(name: string): void {
  const t = pending.get(name);
  if (t) clearTimeout(t);
  pending.set(name, setTimeout(() => { pending.delete(name); checkForChange(name); }, WATCH_DEBOUNCE_MS));
}

/**
 * Compare the file on disk with what we last knew; if it changed, hand the new
 * document to the watchers. Exported for tests and for a caller that knows a
 * change just happened.
 */
export function checkForChange(name: string): void {
  const st = stateOf(name);
  const bytes = readBytes(name);
  if (bytes === null || bytes === st.bytes) return;
  let doc: any;
  try {
    doc = JSON.parse(bytes);
  } catch (err) {
    // Remember the bytes so the same broken file doesn't re-warn per event.
    st.bytes = bytes;
    console.warn(`[settings-files] ${name}: invalid JSON, keeping the current values`, err);
    return;
  }
  const prev = st.doc;
  st.bytes = bytes;
  st.doc = doc;
  for (const l of listeners.get(name) ?? []) {
    try { l(doc, prev); } catch (err) { console.warn(`[settings-files] ${name} watcher threw`, err); }
  }
}

/** Call `cb(doc, prev)` whenever `name` changes on disk by someone else;
 *  `prev` is the document as we last read or wrote it. */
export function watchSettings(name: string, cb: Listener): () => void {
  if (!settingsFilesAvailable()) return () => {};
  let set = listeners.get(name);
  if (!set) { set = new Set(); listeners.set(name, set); }
  set.add(cb);
  ensureWatcher();
  return () => { set!.delete(cb); };
}

/** As `watchSettings`, for one section — fires only when THAT section changed. */
export function watchSection<T = any>(name: string, key: string, cb: (value: T | undefined) => void): () => void {
  const pick = (d: any) => (d && typeof d === 'object' ? d[key] : undefined);
  return watchSettings(name, (doc, prev) => {
    const value = pick(doc);
    if (JSON.stringify(value ?? null) === JSON.stringify(pick(prev) ?? null)) return;
    cb(value);
  });
}

/** Tests: forget every cached file and stop watching. */
export function resetSettingsFilesForTest(): void {
  dirWatcher?.close();
  dirWatcher = null;
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  files.clear();
  listeners.clear();
}

/** The per-surface file names — one place, so a rename can't miss a reader. */
export const SETTINGS_FILES = {
  arrangement: 'arrangement.json',
  remoteControl: 'remote-control.json',
  midiDevices: 'midi-devices.json',
  libraryPaths: 'library-paths.json',
} as const;
