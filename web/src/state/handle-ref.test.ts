import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHandleRef, resolveHandleRef, resolveFileRef, describeRef } from './handle-ref';
import { libraryPaths } from './library-paths';

// ── Mock FileSystemHandle tree with resolve()/walk/permission ──
class MFile {
  kind = 'file' as const;
  constructor(public name: string) {}
  async isSameEntry(o: any) { return o === this; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
}
class MDir {
  kind = 'directory' as const;
  children = new Map<string, MFile | MDir>();
  constructor(public name: string) {}
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  async isSameEntry(o: any) { return o === this; }
  async getDirectoryHandle(n: string, opts?: { create?: boolean }) {
    let d = this.children.get(n);
    if (!d) { if (!opts?.create) throw new Error('NotFound'); d = new MDir(n); this.children.set(n, d); }
    return d as any;
  }
  async getFileHandle(n: string, opts?: { create?: boolean }) {
    let f = this.children.get(n);
    if (!f) { if (!opts?.create) throw new Error('NotFound'); f = new MFile(n); this.children.set(n, f); }
    return f as any;
  }
  /** Return the relative path components to `target`, or null. */
  async resolve(target: any): Promise<string[] | null> {
    if (target === this) return [];
    const dfs = (dir: MDir, prefix: string[]): string[] | null => {
      for (const [n, c] of dir.children) {
        if (c === target) return [...prefix, n];
        if (c.kind === 'directory') { const r = dfs(c, [...prefix, n]); if (r) return r; }
      }
      return null;
    };
    return dfs(this, []);
  }
}

function buildLib(): { lib: MDir; sub: MDir; file: MFile } {
  const lib = new MDir('library');
  const sub = new MDir('scenes');
  const file = new MFile('intro.nano-arr');
  sub.children.set('intro.nano-arr', file);
  lib.children.set('scenes', sub);
  return { lib, sub, file };
}

describe('handle-ref', () => {
  beforeEach(async () => {
    await libraryPaths.ensureLoaded(); // resolves empty (no IDB in jsdom)
    (libraryPaths as any).paths = [];
  });

  it('makes a library-relative ref for a handle under a library path', async () => {
    const { lib, file } = buildLib();
    (libraryPaths as any).paths = [{ id: 'L1', handle: lib, label: 'lib', addedAt: 0 }];
    const ref = await makeHandleRef(file as any);
    expect(ref).toEqual({ kind: 'lib', libraryId: 'L1', path: ['scenes', 'intro.nano-arr'] });
  });

  it('resolves a library-relative ref back to the same handle', async () => {
    const { lib, file } = buildLib();
    (libraryPaths as any).paths = [{ id: 'L1', handle: lib, label: 'lib', addedAt: 0 }];
    const ref = await makeHandleRef(file as any);
    const back = await resolveFileRef(ref);
    expect(back).toBe(file);
  });

  it('falls back to a direct ref when not under any library', async () => {
    const lone = new MFile('lonely.nano-arr');
    const ref = await makeHandleRef(lone as any);
    expect(ref.kind).toBe('direct');
    const back = await resolveHandleRef(ref, 'file');
    expect(back).toBe(lone);
  });

  it('resolves the library directory itself (empty path)', async () => {
    const { lib } = buildLib();
    (libraryPaths as any).paths = [{ id: 'L1', handle: lib, label: 'lib', addedAt: 0 }];
    const ref = await makeHandleRef(lib as any);
    expect(ref).toEqual({ kind: 'lib', libraryId: 'L1', path: [] });
    expect(await resolveHandleRef(ref, 'directory')).toBe(lib);
  });

  it('returns null when the referenced library was removed', async () => {
    const { lib, file } = buildLib();
    (libraryPaths as any).paths = [{ id: 'L1', handle: lib, label: 'lib', addedAt: 0 }];
    const ref = await makeHandleRef(file as any);
    (libraryPaths as any).paths = []; // library removed
    expect(await resolveFileRef(ref)).toBeNull();
    expect(describeRef(ref)).toContain('missing library');
  });

  it('prefers the most specific (shortest path) library when nested', async () => {
    const { lib, sub, file } = buildLib();
    (libraryPaths as any).paths = [
      { id: 'OUTER', handle: lib, label: 'outer', addedAt: 0 },
      { id: 'INNER', handle: sub, label: 'inner', addedAt: 1 },
    ];
    const ref = await makeHandleRef(file as any);
    expect(ref).toEqual({ kind: 'lib', libraryId: 'INNER', path: ['intro.nano-arr'] });
  });

  // ── path-only libraries (hand-entered absolute path, no handle) ──
  describe('path-only libraries', () => {
    afterEach(() => { delete (globalThis as any).require; });

    it('makeHandleRef ignores them — there is nothing to resolve against', async () => {
      const { lib, file } = buildLib();
      (libraryPaths as any).paths = [
        { id: 'PATHONLY', absolutePath: '/Volumes/media', label: 'media', addedAt: 0 },
        { id: 'L1', handle: lib, label: 'lib', addedAt: 1 },
      ];
      const ref = await makeHandleRef(file as any);
      expect(ref).toEqual({ kind: 'lib', libraryId: 'L1', path: ['scenes', 'intro.nano-arr'] });
    });

    it('resolveHandleRef synthesizes a handle from the absolute path under Electron', async () => {
      // The point of the whole feature: a library with no browser grant still
      // resolves once a real filesystem is available.
      const files = new Map([['/Volumes/media/scenes/intro.nano-arr', 'x']]);
      (globalThis as any).require = (mod: string) => {
        if (mod !== 'fs') throw new Error(mod);
        return {
          promises: {
            stat: async (p: string) => {
              const path = p.replace(/\/+$/, '') || '/';
              if (files.has(path)) return { isDirectory: () => false, isFile: () => true, mtimeMs: 0 };
              for (const f of files.keys()) {
                if (f.startsWith(`${path}/`)) return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
              }
              const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
            },
          },
        };
      };
      (libraryPaths as any).paths = [
        { id: 'PATHONLY', absolutePath: '/Volumes/media', label: 'media', addedAt: 0 },
      ];
      const got = await resolveFileRef({
        kind: 'lib', libraryId: 'PATHONLY', path: ['scenes', 'intro.nano-arr'],
      });
      expect(got).not.toBeNull();
      expect(got!.name).toBe('intro.nano-arr');
    });

    it('resolves to null off Electron (no filesystem to reach)', async () => {
      (libraryPaths as any).paths = [
        { id: 'PATHONLY', absolutePath: '/Volumes/media', label: 'media', addedAt: 0 },
      ];
      expect(await resolveFileRef({
        kind: 'lib', libraryId: 'PATHONLY', path: ['scenes', 'intro.nano-arr'],
      })).toBeNull();
    });
  });
});
