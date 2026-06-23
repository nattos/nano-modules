/**
 * HandleRef — a durable, relocatable reference to a file or directory handle.
 *
 * Two shapes:
 *   - `lib`    : RELATIVE to a library path — `{ libraryId, path[] }`. Resolved
 *                by walking `path` under the library directory (so one permission
 *                grant on the library root covers it). This is preferred: it
 *                survives the individual handle being re-picked, and a library
 *                folder can be moved/re-granted without re-linking each file.
 *   - `direct` : a standalone `FileSystemHandle` (the fallback when the target
 *                isn't under any known library path).
 *
 * `makeHandleRef` uses `FileSystemDirectoryHandle.resolve()` to discover whether
 * a handle lives under a library path (it returns the relative path components,
 * or null). Everything that persists a handle — media, workspaces — should go
 * through here so a single library re-grant rehydrates all of it.
 */

import { libraryPaths } from './library-paths';

export type HandleRef =
  | { kind: 'lib'; libraryId: string; path: string[] }
  | { kind: 'direct'; handle: FileSystemHandle };

/**
 * Query — and optionally request — permission on a handle. Query-only by
 * default (safe on boot / outside a gesture); `prompt: true` may show the
 * browser prompt and so must run inside a user gesture. Handles with no
 * permission model (OPFS) are treated as granted.
 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
  prompt = false,
): Promise<boolean> {
  const h = handle as any;
  if (typeof h.queryPermission !== 'function') return true; // OPFS / no perm model
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  if (!prompt || typeof h.requestPermission !== 'function') return false;
  return (await h.requestPermission({ mode })) === 'granted';
}

/**
 * Build a durable reference to `handle`. Prefers a library-relative ref (the
 * most specific = shortest relative path) when the handle lives under a library
 * path; otherwise a direct handle ref.
 */
export async function makeHandleRef(handle: FileSystemHandle): Promise<HandleRef> {
  await libraryPaths.ensureLoaded();
  let best: { libraryId: string; path: string[] } | null = null;
  for (const lib of libraryPaths.paths) {
    let rel: string[] | null = null;
    try {
      rel = await lib.handle.resolve(handle); // null if not a descendant
    } catch { rel = null; }
    if (rel && (!best || rel.length < best.path.length)) {
      best = { libraryId: lib.id, path: rel };
    }
  }
  if (best) return { kind: 'lib', libraryId: best.libraryId, path: best.path };
  return { kind: 'direct', handle };
}

/** Walk `path` (relative components) under `dir` to a file/dir handle. */
async function walkTo(
  dir: FileSystemDirectoryHandle,
  path: string[],
  kind: 'file' | 'directory',
): Promise<FileSystemHandle> {
  if (path.length === 0) return dir; // the directory itself (resolve() returns [])
  let cur = dir;
  for (let i = 0; i < path.length - 1; i++) {
    cur = await cur.getDirectoryHandle(path[i]);
  }
  const last = path[path.length - 1];
  return kind === 'file' ? cur.getFileHandle(last) : cur.getDirectoryHandle(last);
}

/**
 * Resolve a reference back to a live handle, or null if it can't be reached
 * (library removed, permission declined, path gone). `prompt` permits a
 * permission prompt (gesture-only).
 */
export interface ResolveOpts {
  /** Permit a permission prompt (must run inside a user gesture). */
  prompt?: boolean;
  /** Permission mode to require (default 'readwrite'). Use 'read' for media. */
  mode?: 'read' | 'readwrite';
}

export async function resolveHandleRef(
  ref: HandleRef,
  kind: 'file' | 'directory',
  opts: ResolveOpts = {},
): Promise<FileSystemHandle | null> {
  const mode = opts.mode ?? 'readwrite';
  if (ref.kind === 'direct') {
    if (!(await ensurePermission(ref.handle, mode, opts.prompt))) return null;
    return ref.handle;
  }
  await libraryPaths.ensureLoaded();
  const lib = libraryPaths.get(ref.libraryId);
  if (!lib) return null; // library was removed → reference invalidated
  if (!(await ensurePermission(lib.handle, mode, opts.prompt))) return null;
  try {
    return await walkTo(lib.handle, ref.path, kind);
  } catch {
    return null; // path no longer exists under the library
  }
}

/** Typed convenience: resolve to a file handle. */
export async function resolveFileRef(
  ref: HandleRef,
  opts?: ResolveOpts,
): Promise<FileSystemFileHandle | null> {
  return (await resolveHandleRef(ref, 'file', opts)) as FileSystemFileHandle | null;
}

/** Typed convenience: resolve to a directory handle. */
export async function resolveDirRef(
  ref: HandleRef,
  opts?: ResolveOpts,
): Promise<FileSystemDirectoryHandle | null> {
  return (await resolveHandleRef(ref, 'directory', opts)) as FileSystemDirectoryHandle | null;
}

/** A short human description of where a ref points (for relink UIs). */
export function describeRef(ref: HandleRef): string {
  if (ref.kind === 'direct') return (ref.handle as any).name ?? 'file';
  const lib = libraryPaths.get(ref.libraryId);
  const tail = ref.path.join('/') || '.';
  return lib ? `${lib.label}/${tail}` : `(missing library)/${tail}`;
}
