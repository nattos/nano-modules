import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// In-memory IDB — the real one isn't available under vitest.
const idb = new Map<string, any>();
vi.mock('./idb-store', () => ({
  STORE_LIBRARY: 'libraryPaths',
  idbGetAll: async () => [...idb.values()],
  idbPut: async (_store: string, value: any) => { idb.set(value.id, value); },
  idbDelete: async (_store: string, key: string) => { idb.delete(key); },
}));

import { libraryPaths, type LibraryPathSync } from './library-paths';
import type { PathsDirectoryHandle } from './paths';

/** Minimal browser-style directory handle: no absolute path anywhere. */
function browserDir(name: string): PathsDirectoryHandle {
  const self: any = {
    kind: 'directory',
    name,
    isSameEntry: async (o: any) => o === self,
    resolve: async () => null,
    getDirectoryHandle: async () => { throw new Error('x'); },
    getFileHandle: async () => { throw new Error('x'); },
    removeEntry: async () => {},
    values: async function* () {},
  };
  return self as PathsDirectoryHandle;
}

/** An fs-backed handle as `paths.ts` produces one (duck-typed by absPath). */
function fsDir(absPath: string): PathsDirectoryHandle {
  const self: any = {
    ...browserDir(absPath.slice(absPath.lastIndexOf('/') + 1)),
    isFsHandle: true,
    absPath,
  };
  self.isSameEntry = async (o: any) => o?.isFsHandle && o.absPath === absPath;
  return self as PathsDirectoryHandle;
}

async function reset() {
  idb.clear();
  await libraryPaths.ensureLoaded();
  (libraryPaths as any).paths = [];
  libraryPaths.bindBridge(null);
}

beforeEach(reset);
afterEach(() => { delete (globalThis as any).require; });

describe('library-paths — locators', () => {
  it('a web-picked folder is handle-only (invisible to the native side)', async () => {
    const rec = await libraryPaths.add(browserDir('footage'));
    expect(rec.handle).toBeDefined();
    expect(rec.absolutePath).toBeUndefined();
    expect(libraryPaths.syncRows()).toEqual([]);
  });

  it('an Electron-picked folder carries its absolute path automatically', async () => {
    const rec = await libraryPaths.add(fsDir('/Users/x/footage'));
    expect(rec.absolutePath).toBe('/Users/x/footage');
    expect(libraryPaths.syncRows()).toEqual([
      { id: rec.id, label: 'footage', absolutePath: '/Users/x/footage' },
    ]);
  });

  it('addAbsolute makes a path-only row on the web', async () => {
    const rec = await libraryPaths.addAbsolute('/Volumes/media/');
    expect(rec).not.toBeNull();
    expect(rec!.handle).toBeUndefined();
    // Trailing separator normalized away, so dedupe compares cleanly.
    expect(rec!.absolutePath).toBe('/Volumes/media');
    expect(libraryPaths.syncRows()[0].absolutePath).toBe('/Volumes/media');
  });

  it('setAbsolutePath upgrades a handle-only row, clearAbsolutePath reverses it', async () => {
    const rec = await libraryPaths.add(browserDir('footage'));
    await libraryPaths.setAbsolutePath(rec.id, '/Users/x/footage');
    expect(libraryPaths.syncRows()).toHaveLength(1);
    await libraryPaths.clearAbsolutePath(rec.id);
    expect(libraryPaths.syncRows()).toEqual([]);
  });

  it('refuses to clear the absolute path off a path-only row', async () => {
    // It's the row's ONLY locator — clearing it would leave an entry that
    // points nowhere at all.
    const rec = (await libraryPaths.addAbsolute('/Volumes/media'))!;
    await libraryPaths.clearAbsolutePath(rec.id);
    expect(libraryPaths.get(rec.id)?.absolutePath).toBe('/Volumes/media');
  });
});

describe('library-paths — dedupe', () => {
  it('dedupes by same-entry', async () => {
    const dir = browserDir('footage');
    const a = await libraryPaths.add(dir);
    const b = await libraryPaths.add(dir);
    expect(b.id).toBe(a.id);
    expect(libraryPaths.paths).toHaveLength(1);
  });

  it('dedupes by absolute path across different handle objects', async () => {
    const a = await libraryPaths.add(fsDir('/Users/x/footage'));
    const b = await libraryPaths.add(fsDir('/Users/x/footage'));
    expect(b.id).toBe(a.id);
    expect(libraryPaths.paths).toHaveLength(1);
  });

  it('re-picking a hand-entered path attaches the handle to the SAME row', async () => {
    // Otherwise a document authored against the typed row would keep pointing
    // at a library id that the browser can no longer resolve.
    const typed = (await libraryPaths.addAbsolute('/Users/x/footage'))!;
    const picked = await libraryPaths.add(fsDir('/Users/x/footage'));
    expect(picked.id).toBe(typed.id);
    expect(picked.handle).toBeDefined();
    expect(libraryPaths.paths).toHaveLength(1);
  });
});

describe('library-paths — bridge mirror', () => {
  it('pushes on bind and on every mutation, path-only rows excluded', async () => {
    const pushes: LibraryPathSync[][] = [];
    libraryPaths.bindBridge((rows) => pushes.push(rows));
    expect(pushes).toEqual([[]]); // pushed once on bind

    await libraryPaths.add(browserDir('nope'));       // no absolute path
    expect(pushes[pushes.length - 1]).toEqual([]);

    const rec = await libraryPaths.add(fsDir('/Users/x/footage'));
    expect(pushes[pushes.length - 1]).toEqual([
      { id: rec.id, label: 'footage', absolutePath: '/Users/x/footage' },
    ]);

    await libraryPaths.remove(rec.id);
    expect(pushes[pushes.length - 1]).toEqual([]);
  });
});
