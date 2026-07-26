/**
 * Persist + restore the active workspace directory.
 *
 * The workspace folder is stored as a `HandleRef` (see `handle-ref.ts`): if it
 * lives under a library path it's kept RELATIVE to that library, so granting the
 * library once re-mounts the workspace without a separate prompt; otherwise it
 * falls back to a direct handle.
 */

import { idbGet, idbPut, idbDelete, STORE_WORKSPACE } from '../../../state/idb-store';
import { DirectoryBackend } from './backend';
import { HandleRef, makeHandleRef, resolveDirRef } from '../../../state/handle-ref';
import type { PathsDirectoryHandle } from '../../../state/paths';

const CURRENT_KEY = 'current';

interface WorkspaceHandleRecord {
  id: string; // 'current'
  /** Library-relative or direct reference to the workspace directory. */
  ref: HandleRef;
  label: string;
  mountedAt: number;
}

/** Remember a workspace so it can be re-mounted after reload. */
export async function rememberWorkspace(dir: PathsDirectoryHandle, label: string): Promise<void> {
  const ref = await makeHandleRef(dir);
  const rec: WorkspaceHandleRecord = { id: CURRENT_KEY, ref, label, mountedAt: Date.now() };
  await idbPut(STORE_WORKSPACE, rec);
}

/** Forget the active workspace (e.g. user unmounts). */
export async function forgetWorkspace(): Promise<void> {
  await idbDelete(STORE_WORKSPACE, CURRENT_KEY);
}

/**
 * Re-mount the remembered workspace, prompting for permission if needed (call
 * from a user gesture). Returns null if none is remembered or it can't resolve.
 */
export async function restoreWorkspace(): Promise<DirectoryBackend | null> {
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  if (!rec) return null;
  const dir = await resolveDirRef(rec.ref, { prompt: true });
  return dir ? new DirectoryBackend(dir, rec.label) : null;
}

/** Re-mount silently — query-only, no prompt (safe on boot). */
export async function restoreWorkspaceSilent(): Promise<DirectoryBackend | null> {
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  if (!rec) return null;
  const dir = await resolveDirRef(rec.ref, { prompt: false });
  return dir ? new DirectoryBackend(dir, rec.label) : null;
}

/** Peek at the remembered workspace's label without touching permission. */
export async function rememberedWorkspaceLabel(): Promise<string | null> {
  const rec = await idbGet<WorkspaceHandleRecord>(STORE_WORKSPACE, CURRENT_KEY);
  return rec?.label ?? null;
}
