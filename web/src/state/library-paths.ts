/**
 * Global library paths — the user's chosen root directories.
 *
 * A library path names a root the app can resolve files under. File and
 * workspace references (see `handle-ref.ts`) express themselves RELATIVE to a
 * library path when the target lives beneath one, so a single grant on the root
 * unlocks everything under it across reloads. Persisted in IndexedDB
 * (`STORE_LIBRARY`); a MobX observable so the Settings UI re-renders.
 *
 * A path carries up to TWO locators, and which ones it has decides who can use it:
 *
 *   - `handle`       — a directory handle. Only the browser can mint one, and
 *                      only it can resolve on the web.
 *   - `absolutePath` — a real filesystem path. Typed by hand, or discovered
 *                      ("located") under Electron. This is the ONLY locator the
 *                      native executor can use, because all it ever receives is
 *                      the composition JSON.
 *
 * At least one must be present. Under Electron the two arrive together: a picked
 * directory IS an absolute path, so `add()` fills both.
 */

import { makeAutoObservable, runInAction, toJS } from 'mobx';
import { idbGetAll, idbPut, idbDelete, STORE_LIBRARY } from './idb-store';
import {
  absPathOf,
  deserializeHandle,
  getHandleFromAbsPath,
  isElectron,
  normalizeAbsPath,
  type PathsDirectoryHandle,
} from './paths';

export interface LibraryPath {
  /** Stable generated id; references store this, not the handle. */
  id: string;
  /**
   * Browser directory handle. Absent for a hand-entered absolute path (the
   * browser can't manufacture a handle from a string).
   */
  handle?: PathsDirectoryHandle;
  /**
   * Absolute filesystem path. Set by hand, or filled automatically under
   * Electron. Absent for a web-picked folder — which is exactly why a web-only
   * library can't be resolved natively.
   */
  absolutePath?: string;
  /** Human label (defaults to the folder name). */
  label: string;
  addedAt: number;
}

/** The row shape mirrored to the native side — only what it can act on. */
export interface LibraryPathSync {
  id: string;
  label: string;
  absolutePath: string;
}

class LibraryController {
  /** Loaded library paths, oldest first. Observable. */
  paths: LibraryPath[] = [];
  loaded = false;
  private loadPromise: Promise<void> | null = null;
  private bridge: ((rows: LibraryPathSync[]) => void) | null = null;

  constructor() {
    makeAutoObservable<LibraryController, 'loadPromise' | 'bridge'>(
      this,
      { loadPromise: false, bridge: false },
      { autoBind: true },
    );
  }

  /** Load once from IDB (idempotent). */
  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load() {
    let recs: LibraryPath[] = [];
    try {
      recs = await idbGetAll<LibraryPath>(STORE_LIBRARY);
    } catch (err) {
      console.warn('[library-paths] load failed', err);
    }
    recs.sort((a, b) => a.addedAt - b.addedAt);
    // Structured clone strips the prototype off an fs-backed handle — without
    // this it comes back as inert data and every resolve silently fails.
    for (const r of recs) r.handle = deserializeHandle(r.handle);
    runInAction(() => {
      this.paths = recs;
      this.loaded = true;
    });
    this.mirror();
  }

  get(id: string): LibraryPath | undefined {
    return this.paths.find((p) => p.id === id);
  }

  /**
   * Live-mode bridge mirror (wired by boot-resolume, mirroring the MIDI device
   * library). Call again on reconnect — it re-pushes.
   */
  bindBridge(push: ((rows: LibraryPathSync[]) => void) | null): void {
    this.bridge = push;
    this.mirror();
  }

  /**
   * Rows the native side can act on: those with an absolute path. Deliberately
   * a plain method called from each mutation rather than a MobX reaction —
   * reactions are UI-only here.
   */
  syncRows(): LibraryPathSync[] {
    return toJS(this.paths)
      .filter((p): p is LibraryPath & { absolutePath: string } => !!p.absolutePath)
      .map((p) => ({ id: p.id, label: p.label, absolutePath: p.absolutePath }));
  }

  private mirror(): void {
    this.bridge?.(this.syncRows());
  }

  private async persist(rec: LibraryPath): Promise<void> {
    // toJS: a MobX proxy can't be structured-cloned into IndexedDB. The handle
    // is passed through as-is (a real FSA handle is clonable; an FsHandle
    // clones to data and is rehydrated on load).
    await idbPut(STORE_LIBRARY, { ...toJS(rec), handle: rec.handle });
  }

  /** The existing entry for this handle / absolute path, if any. */
  private async findExisting(
    handle?: PathsDirectoryHandle,
    absolutePath?: string,
  ): Promise<LibraryPath | undefined> {
    for (const p of this.paths) {
      if (absolutePath && p.absolutePath && p.absolutePath === absolutePath) return p;
      if (handle && p.handle) {
        try {
          if (await p.handle.isSameEntry(handle)) return p;
        } catch { /* not comparable — treat as distinct */ }
      }
    }
    return undefined;
  }

  /**
   * Add a directory as a library path (dedup by same-entry / same absolute
   * path). Under Electron the absolute path comes along for free — that IS the
   * "located" case. An existing entry is UPGRADED rather than duplicated, so
   * re-picking a hand-entered path attaches a handle to it.
   */
  async add(handle: PathsDirectoryHandle, label?: string): Promise<LibraryPath> {
    await this.ensureLoaded();
    const absolutePath = absPathOf(handle);
    const existing = await this.findExisting(handle, absolutePath);
    if (existing) {
      const patched = !existing.handle || (absolutePath && !existing.absolutePath);
      if (patched) {
        runInAction(() => {
          existing.handle ??= handle;
          if (absolutePath) existing.absolutePath ??= absolutePath;
        });
        await this.persist(existing);
        this.mirror();
      }
      return existing;
    }
    const rec: LibraryPath = {
      id: crypto.randomUUID(),
      handle,
      ...(absolutePath ? { absolutePath } : {}),
      label: label || handle.name || 'library',
      addedAt: Date.now(),
    };
    await this.persist(rec);
    runInAction(() => { this.paths = [...this.paths, rec]; });
    this.mirror();
    return rec;
  }

  /**
   * Add a library path by absolute path alone. On the web this yields a
   * path-only entry: it can't resolve locally (no handle), but it DOES let the
   * native side resolve documents authored against it. Under Electron a handle
   * is attached too, so it works everywhere.
   */
  async addAbsolute(absolutePath: string, label?: string): Promise<LibraryPath | null> {
    await this.ensureLoaded();
    const abs = normalizeAbsPath(absolutePath);
    if (!abs) return null;
    const handle = (await getHandleFromAbsPath(abs)) as PathsDirectoryHandle | undefined;
    if (handle && handle.kind !== 'directory') return null;
    const existing = await this.findExisting(handle, abs);
    if (existing) {
      runInAction(() => {
        existing.absolutePath = abs;
        if (handle) existing.handle ??= handle;
      });
      await this.persist(existing);
      this.mirror();
      return existing;
    }
    const rec: LibraryPath = {
      id: crypto.randomUUID(),
      ...(handle ? { handle } : {}),
      absolutePath: abs,
      label: label || abs.slice(abs.lastIndexOf('/') + 1) || abs,
      addedAt: Date.now(),
    };
    await this.persist(rec);
    runInAction(() => { this.paths = [...this.paths, rec]; });
    this.mirror();
    return rec;
  }

  /** Attach / correct the absolute path of an existing entry. */
  async setAbsolutePath(id: string, absolutePath: string): Promise<void> {
    const rec = this.get(id);
    if (!rec) return;
    const abs = normalizeAbsPath(absolutePath);
    runInAction(() => { rec.absolutePath = abs || undefined; });
    await this.persist(rec);
    this.mirror();
  }

  /** Drop the absolute path (the entry stays usable on the web via its handle). */
  async clearAbsolutePath(id: string): Promise<void> {
    const rec = this.get(id);
    if (!rec || !rec.handle) return; // would leave an entry with no locator at all
    runInAction(() => { rec.absolutePath = undefined; });
    await this.persist(rec);
    this.mirror();
  }

  /**
   * Discover the absolute path of an existing handle-only entry via the native
   * directory picker (Electron). The user re-picks the same folder; we keep the
   * entry and record where it lives. Must run from a user gesture.
   */
  async locate(id: string): Promise<boolean> {
    if (!isElectron()) return false;
    const rec = this.get(id);
    if (!rec) return false;
    const { showDirectoryPicker } = await import('./paths');
    const dir = await showDirectoryPicker();
    const abs = dir ? absPathOf(dir) : undefined;
    if (!abs) return false;
    runInAction(() => {
      rec.absolutePath = abs;
      rec.handle ??= dir;
    });
    await this.persist(rec);
    this.mirror();
    return true;
  }

  /** Remove a library path. Invalidates any references relative to it. */
  async remove(id: string): Promise<void> {
    await idbDelete(STORE_LIBRARY, id);
    runInAction(() => { this.paths = this.paths.filter((p) => p.id !== id); });
    this.mirror();
  }
}

/** App-wide singleton. */
export const libraryPaths = new LibraryController();
