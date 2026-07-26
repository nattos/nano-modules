import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isElectron,
  absPathOf,
  deserializeHandle,
  getHandleFromAbsPath,
  normalizeAbsPath,
  type PathsDirectoryHandle,
  type PathsFileHandle,
} from './paths';

/**
 * A tiny in-memory `fs.promises` — enough for the handle surface. Files are
 * absolute-path keys; directories are implied by their children plus an
 * explicit set (so an empty directory still exists).
 */
class FakeFs {
  files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  dirs = new Set<string>(['/']);

  addDir(p: string) {
    for (let cur = p; cur.length > 1; cur = cur.slice(0, cur.lastIndexOf('/')) || '/') {
      this.dirs.add(cur);
    }
    this.dirs.add('/');
  }
  addFile(p: string, text = '', mtimeMs = 1000) {
    this.addDir(p.slice(0, p.lastIndexOf('/')) || '/');
    this.files.set(p, { data: new TextEncoder().encode(text), mtimeMs });
  }

  promises = {
    stat: async (p: string) => {
      const path = normalizeAbsPath(p);
      const f = this.files.get(path);
      if (f) return { isDirectory: () => false, isFile: () => true, mtimeMs: f.mtimeMs };
      if (this.dirs.has(path)) return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFile: async (p: string) => {
      const f = this.files.get(normalizeAbsPath(p));
      if (!f) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return f.data;
    },
    writeFile: async (p: string, data: Uint8Array) => {
      this.addFile(normalizeAbsPath(p));
      this.files.set(normalizeAbsPath(p), { data, mtimeMs: 2000 });
    },
    mkdir: async (p: string) => { this.addDir(normalizeAbsPath(p)); },
    rm: async (p: string) => {
      const path = normalizeAbsPath(p);
      this.files.delete(path);
      this.dirs.delete(path);
    },
    readdir: async (p: string) => {
      const base = normalizeAbsPath(p);
      const prefix = base === '/' ? '/' : `${base}/`;
      const names = new Map<string, boolean>(); // name → isDirectory
      for (const f of this.files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        if (!rest) continue;
        const head = rest.split('/')[0];
        names.set(head, rest.includes('/'));
      }
      for (const d of this.dirs) {
        if (d === base || !d.startsWith(prefix)) continue;
        names.set(d.slice(prefix.length).split('/')[0], true);
      }
      return [...names].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    },
  };
}

let fake: FakeFs;

function installElectron(fs: FakeFs) {
  (globalThis as any).require = (mod: string) => {
    if (mod === 'fs') return fs;
    if (mod === 'electron') return {};
    throw new Error(`unexpected require(${mod})`);
  };
}

beforeEach(() => {
  fake = new FakeFs();
  fake.addFile('/lib/footage/a.mov', 'aaa');
  fake.addFile('/lib/footage/b.mov', 'bbb');
  fake.addDir('/lib/empty');
  fake.addFile('/libother/c.mov', 'ccc'); // sibling that shares a string prefix
  installElectron(fake);
});

afterEach(() => {
  delete (globalThis as any).require;
});

describe('paths — Electron detection', () => {
  it('is true only while require exists', () => {
    expect(isElectron()).toBe(true);
    delete (globalThis as any).require;
    expect(isElectron()).toBe(false);
  });
});

describe('paths — FsDirectoryHandle', () => {
  it('resolves a descendant to its relative components', async () => {
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    const file = (await getHandleFromAbsPath('/lib/footage/a.mov'))!;
    expect(await lib.resolve(file)).toEqual(['footage', 'a.mov']);
  });

  it('resolves the directory itself to an empty path', async () => {
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    expect(await lib.resolve(lib)).toEqual([]);
  });

  it('does not treat a string-prefix sibling as a descendant', async () => {
    // /libother starts with "/lib" — a bare startsWith would call it a child.
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    const other = (await getHandleFromAbsPath('/libother/c.mov'))!;
    expect(await lib.resolve(other)).toBeNull();
  });

  it('returns null for a non-fs (browser) handle', async () => {
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    expect(await lib.resolve({ kind: 'file', name: 'x' } as any)).toBeNull();
  });

  it('compares entries by absolute path', async () => {
    const a = (await getHandleFromAbsPath('/lib'))!;
    const b = (await getHandleFromAbsPath('/lib/'))!; // trailing separator
    expect(await a.isSameEntry(b)).toBe(true);
    const c = (await getHandleFromAbsPath('/libother'))!;
    expect(await a.isSameEntry(c)).toBe(false);
  });

  it('enumerates children via values()', async () => {
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    const seen: string[] = [];
    for await (const h of lib.values()) seen.push(`${h.kind}:${h.name}`);
    expect(seen.sort()).toEqual(['directory:empty', 'directory:footage']);
  });

  it('throws NotFoundError for a missing entry unless create is set', async () => {
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    // backend.read() and resolveHandleRef both rely on this to tell gone from here.
    await expect(lib.getFileHandle('nope.mov')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(lib.getDirectoryHandle('nope')).rejects.toMatchObject({ name: 'NotFoundError' });
    const made = await lib.getDirectoryHandle('fresh', { create: true });
    expect(made.name).toBe('fresh');
  });
});

describe('paths — FsFileHandle', () => {
  it('reads a File with its name and mtime', async () => {
    const fh = (await getHandleFromAbsPath('/lib/footage/a.mov')) as PathsFileHandle;
    const file = await fh.getFile();
    expect(file.name).toBe('a.mov');
    expect(file.lastModified).toBe(1000);
    expect(await file.text()).toBe('aaa');
  });

  it('writes through createWritable', async () => {
    const dir = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    const fh = await dir.getFileHandle('out.txt', { create: true });
    const w = await fh.createWritable();
    await w.write('hello ');
    await w.write('world');
    await w.close();
    expect(await (await fh.getFile()).text()).toBe('hello world');
  });
});

describe('paths — serialization', () => {
  it('rehydrates a prototype-stripped IDB record', async () => {
    const lib = (await getHandleFromAbsPath('/lib')) as PathsDirectoryHandle;
    // What structured clone hands back: data, no prototype.
    const cloned = JSON.parse(JSON.stringify(lib));
    expect(typeof (cloned as any).resolve).toBe('undefined');
    const back = deserializeHandle(cloned as any) as PathsDirectoryHandle;
    expect(typeof back.resolve).toBe('function');
    expect(absPathOf(back)).toBe('/lib');
    const file = (await getHandleFromAbsPath('/lib/footage/a.mov'))!;
    expect(await back.resolve(file)).toEqual(['footage', 'a.mov']);
  });

  it('passes a browser handle through untouched', () => {
    const browserish = { kind: 'directory', name: 'x' } as any;
    expect(deserializeHandle(browserish)).toBe(browserish);
    expect(absPathOf(browserish)).toBeUndefined();
  });
});

describe('paths — getHandleFromAbsPath', () => {
  it('returns undefined for a missing path, and off Electron', async () => {
    expect(await getHandleFromAbsPath('/nope')).toBeUndefined();
    delete (globalThis as any).require;
    expect(await getHandleFromAbsPath('/lib')).toBeUndefined();
  });
});
