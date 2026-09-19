/**
 * The path helpers on Windows.
 *
 * `paths.ts` reads `process.platform` ONCE, at import, to decide whether `\`
 * is a separator — deliberately, because `\` is a legal character in a POSIX
 * filename and sniffing the string would turn a macOS file genuinely called
 * `a\b` into a directory. That makes this a separate file: it has to reset the
 * module registry and re-import under a faked platform, which would poison the
 * sibling suite's module instance.
 *
 * What is being pinned is the shape the native directory picker actually hands
 * back — `C:\Users\me\Videos`, backslashes and all. Reads always worked
 * (Windows accepts `/` too); what did not was every piece of NAMING derived
 * from it, which is what the arrangement's media library displays.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** An fs keyed on Windows-shaped absolute paths, split on either separator. */
class WinFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();

  private static norm(p: string) {
    let s = p.trim();
    while (s.length > 3 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1);
    return s.replace(/\//g, '\\');
  }
  private static parent(p: string) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : '';
  }

  addDir(p: string) {
    for (let cur = WinFs.norm(p); cur.length > 2; cur = WinFs.parent(cur)) this.dirs.add(cur);
  }
  addFile(p: string, text = '') {
    const n = WinFs.norm(p);
    this.addDir(WinFs.parent(n));
    this.files.set(n, new TextEncoder().encode(text));
  }

  promises = {
    stat: async (p: string) => {
      const n = WinFs.norm(p);
      if (this.files.has(n)) return { isDirectory: () => false, isFile: () => true, mtimeMs: 1 };
      if (this.dirs.has(n)) return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 };
      const err: any = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
    },
    readFile: async (p: string) => {
      const f = this.files.get(WinFs.norm(p));
      if (!f) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return f;
    },
    readdir: async (p: string) => {
      const prefix = `${WinFs.norm(p)}\\`;
      const names = new Map<string, boolean>();
      for (const f of this.files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        names.set(rest.split('\\')[0], rest.includes('\\'));
      }
      for (const d of this.dirs) {
        if (!d.startsWith(prefix)) continue;
        names.set(d.slice(prefix.length).split('\\')[0], true);
      }
      return [...names].map(([name, isDir]) => ({
        name, isDirectory: () => isDir, isFile: () => !isDir,
      }));
    },
    writeFile: async () => {}, mkdir: async () => {}, rm: async () => {},
  };
}

let realPlatform: PropertyDescriptor | undefined;

/** Re-import paths.ts with `process.platform` faked to win32. */
async function importAsWindows() {
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.resetModules();
  return import('./paths');
}

let fs: WinFs;

beforeEach(() => {
  fs = new WinFs();
  fs.addFile('C:\\Users\\me\\Videos\\footage\\a.mov', 'aaa');
  fs.addDir('C:\\Users\\me\\Videos\\empty');
  (globalThis as any).require = (mod: string) => {
    if (mod === 'fs') return fs;
    if (mod === 'electron') return {};
    throw new Error(`unexpected require(${mod})`);
  };
});

afterEach(() => {
  delete (globalThis as any).require;
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  vi.resetModules();
});

describe('paths — Windows separators', () => {
  it('trims a trailing backslash but keeps the drive root', async () => {
    const { normalizeAbsPath } = await importAsWindows();
    expect(normalizeAbsPath('C:\\Users\\me\\Videos\\')).toBe('C:\\Users\\me\\Videos');
    expect(normalizeAbsPath('  C:\\Users\\me\\Videos\\\\  ')).toBe('C:\\Users\\me\\Videos');
  });

  it('names a picked directory after its last segment, not the whole path', async () => {
    const { getHandleFromAbsPath } = await importAsWindows();
    const dir = await getHandleFromAbsPath('C:\\Users\\me\\Videos');
    // The bug this pins: with `/` as the only separator there is no match, so
    // the name came back as the entire `C:\Users\me\Videos`.
    expect(dir?.name).toBe('Videos');
  });

  it('resolves a descendant across either separator', async () => {
    const { getHandleFromAbsPath } = await importAsWindows();
    const dir = (await getHandleFromAbsPath('C:\\Users\\me\\Videos')) as any;
    const viaBack = (await getHandleFromAbsPath('C:\\Users\\me\\Videos\\footage\\a.mov'))!;
    expect(await dir.resolve(viaBack)).toEqual(['footage', 'a.mov']);
    // Anything we JOIN ourselves uses `/`, which Windows accepts; both shapes
    // therefore reach this function and both have to work.
    const viaFwd = (await getHandleFromAbsPath('C:\\Users\\me\\Videos/footage/a.mov'))!;
    expect(await dir.resolve(viaFwd)).toEqual(['footage', 'a.mov']);
  });

  it('still refuses a sibling that merely shares a string prefix', async () => {
    const { getHandleFromAbsPath } = await importAsWindows();
    fs.addFile('C:\\Users\\me\\VideosOld\\c.mov', 'ccc');
    const dir = (await getHandleFromAbsPath('C:\\Users\\me\\Videos')) as any;
    const other = (await getHandleFromAbsPath('C:\\Users\\me\\VideosOld\\c.mov'))!;
    expect(await dir.resolve(other)).toBeNull();
  });

  it('lists children of a backslash directory', async () => {
    const { getHandleFromAbsPath } = await importAsWindows();
    const dir = (await getHandleFromAbsPath('C:\\Users\\me\\Videos')) as any;
    const names: string[] = [];
    for await (const h of dir.values()) names.push(h.name);
    expect(names.sort()).toEqual(['empty', 'footage']);
    // And a child reached through the handle API keeps a usable name, which is
    // what the library tree renders.
    const sub = await dir.getDirectoryHandle('footage');
    expect(sub.name).toBe('footage');
    expect((await sub.getFileHandle('a.mov')).name).toBe('a.mov');
  });
});
