/**
 * Persist + restore the single, global "test input" video used in
 * offline/playground mode as a stand-in for Resolume's live layer feed.
 *
 * One `FileSystemFileHandle` (keyed 'current'), stored directly — it's
 * structured-cloneable, so IndexedDB round-trips it and we can re-open the same
 * on-disk file across reloads after a permission re-grant. Shared browser-wide
 * across every offline + playground instance.
 */

import { idbGet, idbPut, idbDelete, STORE_INPUT_VIDEO } from './idb-store';
import { ensurePermission } from './handle-ref';

const CURRENT_KEY = 'current';

interface InputVideoRecord {
  id: string; // 'current'
  handle: FileSystemFileHandle;
  label: string;
  savedAt: number;
}

/** Remember the chosen input video so it re-loads after reload. */
export async function rememberInputVideo(handle: FileSystemFileHandle): Promise<void> {
  const rec: InputVideoRecord = { id: CURRENT_KEY, handle, label: handle.name, savedAt: Date.now() };
  await idbPut(STORE_INPUT_VIDEO, rec);
}

/** Forget the global input video (the input card's "clear"). */
export async function forgetInputVideo(): Promise<void> {
  await idbDelete(STORE_INPUT_VIDEO, CURRENT_KEY);
}

/** The remembered file's name, or null — for labelling the input card. */
export async function rememberedInputVideoLabel(): Promise<string | null> {
  const rec = await idbGet<InputVideoRecord>(STORE_INPUT_VIDEO, CURRENT_KEY);
  return rec?.label ?? null;
}

/**
 * Re-open the remembered input video as a `File`. `prompt: false` (the boot
 * default) only queries permission — silent, safe before any gesture; a
 * previously-granted handle resolves, otherwise returns null. `prompt: true`
 * (from a user gesture) requests permission if needed.
 */
export async function restoreInputVideoFile(opts: { prompt: boolean }): Promise<File | null> {
  const rec = await idbGet<InputVideoRecord>(STORE_INPUT_VIDEO, CURRENT_KEY);
  if (!rec) return null;
  const ok = await ensurePermission(rec.handle, 'read', opts.prompt);
  if (!ok) return null;
  try {
    return await rec.handle.getFile();
  } catch (err) {
    console.warn('[input-video-store] getFile failed', err);
    return null;
  }
}
