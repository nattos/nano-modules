/**
 * Paths — one handle vocabulary over two filesystems.
 *
 * The app addresses files through the File System Access API (`showDirectoryPicker`,
 * `FileSystemDirectoryHandle`). Under Electron we also have real `fs`, which the
 * browser can't offer: an ABSOLUTE PATH. That's the whole point of this file —
 * an absolute path is the only thing the native executor can resolve, and the
 * browser never learns one.
 *
 * Rather than fork every call site, the `Paths*Handle` interfaces below are
 * STRUCTURALLY COMPATIBLE with the FSA types, so a real `FileSystemDirectoryHandle`
 * satisfies them as-is and `handle-ref.ts`'s walk works over either backend
 * untouched. `FsDirectoryHandle`/`FsFileHandle` implement the same shape over
 * node `fs`. (Ported from nano-player's `renderer/paths.ts`, widened to cover
 * `isSameEntry`, `createWritable` and `removeEntry`, which this app uses and
 * that one didn't.)
 *
 * Three things that are easy to get wrong here:
 *
 *   1. `fs` must NOT be imported. Vite has no `electron-renderer` target and
 *      would try to resolve the specifier at build time. We reach it through
 *      `window.require`, which exists because the BrowserWindow runs with
 *      `nodeIntegration: true` — so the module name never reaches the bundler.
 *   2. IndexedDB stores handles by structured clone, which DROPS THE PROTOTYPE.
 *      An `FsDirectoryHandle` read back is a plain object with `isFsHandle: true`
 *      and no methods; every IDB read path must run it through
 *      {@link deserializeHandle}.
 *   3. A missing entry must THROW from `getFileHandle`/`getDirectoryHandle` when
 *      `create` isn't set — `backend.read()` and `resolveHandleRef` both rely on
 *      that to distinguish "gone" from "here".
 */

// ── Handle interfaces (FSA-shaped) ──────────────────────────────────────────

export type PathsKind = 'file' | 'directory';

export interface PathsHandle {
  readonly kind: PathsKind;
  readonly name: string;
  isSameEntry(other: PathsHandle): Promise<boolean>;
  /** Absent on the FSA types (they're not in lib.dom) and on OPFS handles;
   *  `ensurePermission` treats absence as granted. */
  queryPermission?(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface PathsFileHandle extends PathsHandle {
  readonly kind: 'file';
  getFile(): Promise<File>;
  createWritable(): Promise<PathsWritable>;
}

export interface PathsWritable {
  write(data: FileSystemWriteChunkType): Promise<void>;
  close(): Promise<void>;
}

export interface PathsDirectoryHandle extends PathsHandle {
  readonly kind: 'directory';
  /** Relative components from this directory down to `handle`, `[]` when it IS
   *  this directory, `null` when it isn't a descendant. */
  resolve(handle: PathsHandle): Promise<string[] | null>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<PathsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<PathsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<PathsHandle>;
}

// ── Electron detection + the node bindings ──────────────────────────────────

/** True in the Electron renderer (nodeIntegration exposes `require`). */
export function isElectron(): boolean {
  return typeof (globalThis as any).require === 'function';
}

/** `require` without letting Vite see a static module specifier. */
function nodeRequire<T = any>(mod: string): T | undefined {
  const req = (globalThis as any).require as ((m: string) => T) | undefined;
  if (typeof req !== 'function') return undefined;
  try {
    return req(mod);
  } catch {
    return undefined;
  }
}

function fsMod(): any {
  const fs = nodeRequire<any>('fs');
  if (!fs) throw new Error('[paths] node fs unavailable (not running under Electron)');
  return fs;
}

/** POSIX-ish join that tolerates a trailing separator on `base`. */
function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? base + name : `${base}/${name}`;
}

function baseName(absPath: string): string {
  const trimmed = absPath.endsWith('/') && absPath.length > 1
    ? absPath.slice(0, -1)
    : absPath;
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** Trailing separator removed (except for the root itself) — the canonical form
 *  we compare and store. */
export function normalizeAbsPath(absPath: string): string {
  let p = absPath.trim();
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** A DOMException-shaped miss, so callers that check `err.name === 'NotFoundError'`
 *  behave identically across the two backends. */
function notFound(absPath: string): Error {
  const err = new Error(`no entry at ${absPath}`);
  err.name = 'NotFoundError';
  return err;
}

// ── fs-backed handles ───────────────────────────────────────────────────────

abstract class FsHandle implements PathsHandle {
  /** Survives structured clone — {@link deserializeHandle} keys off it. */
  readonly isFsHandle = true;
  abstract readonly kind: PathsKind;
  readonly name: string;
  readonly absPath: string;

  constructor(absPath: string) {
    this.absPath = normalizeAbsPath(absPath);
    this.name = baseName(this.absPath);
  }

  async isSameEntry(other: PathsHandle): Promise<boolean> {
    const o = other as FsHandle;
    return !!o?.isFsHandle && o.absPath === this.absPath;
  }

  // Real filesystem access needs no grant — the Electron process already has it.
  async queryPermission(): Promise<PermissionState> {
    return 'granted';
  }
  async requestPermission(): Promise<PermissionState> {
    return 'granted';
  }
}

class FsFileHandle extends FsHandle implements PathsFileHandle {
  override readonly kind = 'file' as const;

  async getFile(): Promise<File> {
    const fs = fsMod();
    // Whole-file read. NOT a regression: the video path already does
    // `fetch(url)` → `resp.blob()`, so the file was fully in memory anyway.
    const buf: Uint8Array = await fs.promises.readFile(this.absPath);
    const stat = await fs.promises.stat(this.absPath);
    // Copy into a fresh ArrayBuffer — a node Buffer is a VIEW into a shared pool,
    // so handing the raw buffer to File would expose unrelated bytes.
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    return new File([bytes], this.name, { lastModified: stat.mtimeMs });
  }

  async createWritable(): Promise<PathsWritable> {
    const fs = fsMod();
    const absPath = this.absPath;
    const chunks: Uint8Array[] = [];
    return {
      async write(data: FileSystemWriteChunkType): Promise<void> {
        if (typeof data === 'string') {
          chunks.push(new TextEncoder().encode(data));
        } else if (data instanceof Blob) {
          chunks.push(new Uint8Array(await data.arrayBuffer()));
        } else if (ArrayBuffer.isView(data)) {
          chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        } else if (data instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(data));
        } else {
          throw new Error('[paths] unsupported write chunk type');
        }
      },
      async close(): Promise<void> {
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        await fs.promises.writeFile(absPath, out);
      },
    };
  }

  static deserialize(rec: { absPath: string }): FsFileHandle {
    return new FsFileHandle(rec.absPath);
  }
}

class FsDirectoryHandle extends FsHandle implements PathsDirectoryHandle {
  override readonly kind = 'directory' as const;

  async *values(): AsyncIterable<PathsHandle> {
    const fs = fsMod();
    const entries: any[] = await fs.promises.readdir(this.absPath, { withFileTypes: true });
    for (const e of entries) {
      const child = joinPath(this.absPath, e.name);
      if (e.isDirectory()) yield new FsDirectoryHandle(child);
      else if (e.isFile()) yield new FsFileHandle(child);
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<PathsDirectoryHandle> {
    const fs = fsMod();
    const child = joinPath(this.absPath, name);
    if (options?.create) {
      await fs.promises.mkdir(child, { recursive: true });
    } else {
      let st: any;
      try { st = await fs.promises.stat(child); } catch { throw notFound(child); }
      if (!st.isDirectory()) throw notFound(child);
    }
    return new FsDirectoryHandle(child);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<PathsFileHandle> {
    const fs = fsMod();
    const child = joinPath(this.absPath, name);
    let st: any = null;
    try { st = await fs.promises.stat(child); } catch { /* missing */ }
    if (!st) {
      // The FSA contract: a miss THROWS unless `create` is set. backend.read()
      // and resolveHandleRef both distinguish "gone" from "here" this way.
      if (!options?.create) throw notFound(child);
      await fs.promises.writeFile(child, new Uint8Array(0), { flag: 'wx' }).catch(() => {});
    } else if (!st.isFile()) {
      throw notFound(child);
    }
    return new FsFileHandle(child);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const fs = fsMod();
    await fs.promises.rm(joinPath(this.absPath, name), {
      recursive: !!options?.recursive,
      force: false,
    });
  }

  async resolve(handle: PathsHandle): Promise<string[] | null> {
    const o = handle as FsHandle;
    if (!o?.isFsHandle) return null;
    if (o.absPath === this.absPath) return []; // the directory itself
    // Compare on a separator boundary — a bare startsWith would call
    // /foo/barbaz a descendant of /foo/bar.
    const prefix = this.absPath === '/' ? '/' : `${this.absPath}/`;
    if (!o.absPath.startsWith(prefix)) return null;
    return o.absPath.slice(prefix.length).split('/').filter((s) => s.length > 0);
  }

  static deserialize(rec: { absPath: string }): FsDirectoryHandle {
    return new FsDirectoryHandle(rec.absPath);
  }
}

// ── Module surface ──────────────────────────────────────────────────────────

/** The absolute path behind a handle, or undefined for a browser/OPFS handle. */
export function absPathOf(handle: PathsHandle | undefined): string | undefined {
  const h = handle as FsHandle | undefined;
  return h?.isFsHandle ? h.absPath : undefined;
}

/** Rehydrate a handle read back from IndexedDB. Structured clone preserves the
 *  data of an `FsHandle` but not its prototype; a real FSA handle round-trips
 *  intact and passes through untouched. */
export function deserializeHandle<T extends PathsHandle>(handle: T | undefined): T | undefined {
  if (!handle) return handle;
  const rec = handle as unknown as { isFsHandle?: boolean; kind?: string; absPath?: string };
  if (!rec.isFsHandle || typeof rec.absPath !== 'string') return handle;
  if (rec.kind === 'directory') return FsDirectoryHandle.deserialize({ absPath: rec.absPath }) as unknown as T;
  if (rec.kind === 'file') return FsFileHandle.deserialize({ absPath: rec.absPath }) as unknown as T;
  return undefined;
}

/** A handle for an absolute path, or undefined when it doesn't exist (or we're
 *  not under Electron). */
export async function getHandleFromAbsPath(absPath: string): Promise<PathsHandle | undefined> {
  if (!isElectron()) return undefined;
  const fs = fsMod();
  let st: any;
  try {
    st = await fs.promises.stat(absPath);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return new FsDirectoryHandle(absPath);
  if (st.isFile()) return new FsFileHandle(absPath);
  return undefined;
}

/** Directory handle for an absolute path — created if absent. Electron only. */
export async function createDirectoryFromAbsPath(absPath: string): Promise<PathsDirectoryHandle> {
  if (!isElectron()) throw new Error('[paths] createDirectoryFromAbsPath needs Electron');
  await fsMod().promises.mkdir(absPath, { recursive: true });
  return new FsDirectoryHandle(absPath);
}

/**
 * Pick a directory. Under Electron this goes through the main process (the
 * native dialog returns an absolute path, which is the point); on the web it's
 * the ordinary FSA picker. Must be called from a user gesture either way.
 */
export async function showDirectoryPicker(): Promise<PathsDirectoryHandle | undefined> {
  if (isElectron()) {
    const ipc = nodeRequire<any>('electron')?.ipcRenderer;
    if (!ipc) throw new Error('[paths] electron ipcRenderer unavailable');
    const absPath: string | undefined = await ipc.invoke('paths.showDirectoryPicker');
    return absPath ? new FsDirectoryHandle(absPath) : undefined;
  }
  const picker = (globalThis as any).showDirectoryPicker;
  if (typeof picker !== 'function') {
    throw new Error('File System Access API (showDirectoryPicker) is unavailable');
  }
  return (await picker({ mode: 'readwrite' })) as PathsDirectoryHandle;
}

/**
 * Handles for the files in a drop. Electron gives absolute paths (via
 * `webUtils.getPathForFile`, or the legacy `File.path` on older versions), so a
 * dropped folder becomes a real directory handle; the web path uses
 * `getAsFileSystemHandle`.
 */
export async function handlesFromDataTransfer(dt: DataTransfer): Promise<PathsHandle[]> {
  if (isElectron()) {
    const webUtils = nodeRequire<any>('electron')?.webUtils;
    const absPaths: string[] = [];
    for (const file of Array.from(dt.files)) {
      const p = webUtils?.getPathForFile?.(file) ?? (file as any).path;
      if (typeof p === 'string' && p) absPaths.push(p);
    }
    const handles = await Promise.all(absPaths.map((p) => getHandleFromAbsPath(p)));
    return handles.filter((h): h is PathsHandle => !!h);
  }
  const items = Array.from(dt.items || []).filter(
    (it) => it.kind === 'file' && typeof (it as any).getAsFileSystemHandle === 'function',
  );
  const handles = await Promise.all(
    items.map((it) =>
      ((it as any).getAsFileSystemHandle() as Promise<PathsHandle | null>).catch(() => null),
    ),
  );
  return handles.filter((h): h is PathsHandle => !!h);
}
