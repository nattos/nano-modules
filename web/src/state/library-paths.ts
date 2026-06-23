/**
 * Global library paths — the user's chosen root directories.
 *
 * A library path is a `FileSystemDirectoryHandle` the user grants the app
 * access to. File and workspace references (see `handle-ref.ts`) express
 * themselves RELATIVE to a library path when the target lives under one, so a
 * single permission grant on the root unlocks everything beneath it across
 * reloads. Persisted in IndexedDB (`STORE_LIBRARY`); exposed as a MobX
 * observable so the Settings UI re-renders on add/remove.
 *
 * (When we move to Electron, a single virtual library path can represent the
 * filesystem root, making every reference relative for free.)
 */

import { makeAutoObservable, runInAction } from 'mobx';
import { idbGetAll, idbPut, idbDelete, STORE_LIBRARY } from './idb-store';

export interface LibraryPath {
  /** Stable generated id; references store this, not the handle. */
  id: string;
  handle: FileSystemDirectoryHandle;
  /** Human label (defaults to the folder name). */
  label: string;
  addedAt: number;
}

class LibraryController {
  /** Loaded library paths, oldest first. Observable. */
  paths: LibraryPath[] = [];
  loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor() {
    makeAutoObservable<LibraryController, 'loadPromise'>(
      this,
      { loadPromise: false },
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
    runInAction(() => {
      this.paths = recs;
      this.loaded = true;
    });
  }

  get(id: string): LibraryPath | undefined {
    return this.paths.find((p) => p.id === id);
  }

  /** Add a directory as a library path (dedup by same-entry). Returns it. */
  async add(handle: FileSystemDirectoryHandle, label?: string): Promise<LibraryPath> {
    await this.ensureLoaded();
    for (const p of this.paths) {
      try {
        if (await p.handle.isSameEntry(handle)) return p;
      } catch { /* not comparable — treat as distinct */ }
    }
    const rec: LibraryPath = {
      id: crypto.randomUUID(),
      handle,
      label: label || handle.name || 'library',
      addedAt: Date.now(),
    };
    await idbPut(STORE_LIBRARY, rec);
    runInAction(() => { this.paths = [...this.paths, rec]; });
    return rec;
  }

  /** Remove a library path. Invalidates any references relative to it. */
  async remove(id: string): Promise<void> {
    await idbDelete(STORE_LIBRARY, id);
    runInAction(() => { this.paths = this.paths.filter((p) => p.id !== id); });
  }
}

/** App-wide singleton. */
export const libraryPaths = new LibraryController();
