/**
 * Persist + restore the active workspace directory handle.
 *
 * `FileSystemDirectoryHandle`s are structured-cloneable, so IndexedDB can hold
 * them directly (same trick the video profile-store uses for file handles).
 * On reload we re-read the handle and re-grant permission via a user gesture
 * before re-mounting the same on-disk folder.
 */

import { idbGet, idbPut, idbDelete, STORE_WORKSPACE } from '../../../state/idb-store';
import { DirectoryBackend } from './backend';

const CURRENT_KEY = 'current';

interface WorkspaceHandleRecord {
  id: string; // 'current'
  handle: FileSystemDirectoryHandle;
  label: string;
  mountedAt: number;
}

/** Remember a picked workspace so it can be re-mounted after reload. */
export async function rememberWorkspace(dir: FileSystemDirectoryHandle, label: string): Promise<void> {
  const rec: WorkspaceHandleRecord = {
    id: CURRENT_KEY,
    handle: dir,
    label,
    mountedAt: Date.now(),
  };
  await idbPut(STORE_WORKSPACE, rec);
}

/** Forget the active workspace (e.g. user unmounts). */
export async function forgetWorkspace(): Promise<void> {
  await idbDelete(STORE_WORKSPACE, CURRENT_KEY);
}

/**
 * Query — and if needed request — permission on a handle. `requestPermission`
 * must run inside a user gesture; call this from a click handler on restore.
 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  const opts = { mode } as any;
  const h = handle as any;
  if (typeof h.queryPermission === 'function') {
    if ((await h.queryPermission(opts)) === 'granted') return true;
  }
  if (typeof h.requestPermission === 'function') {
    if ((await h.requestPermission(opts)) === 'granted') return true;
  }
  return false;
}

/**
 * Re-mount the remembered workspace. Returns null if none is remembered or the
 * permission grant is declined. Must be called from a user gesture so the
 * permission re-request can show its prompt.
 */
export async function restoreWorkspace(): Promise<DirectoryBackend | null> {
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  if (!rec?.handle) return null;
  const ok = await ensurePermission(rec.handle, 'readwrite');
  if (!ok) return null;
  return new DirectoryBackend(rec.handle, rec.label);
}

/** Peek at the remembered workspace's label without re-granting permission. */
export async function rememberedWorkspaceLabel(): Promise<string | null> {
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  return rec?.label ?? null;
}
