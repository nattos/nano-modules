/**
 * Persist + restore the single, global "test input" video used in
 * offline/playground mode as a stand-in for Resolume's live layer feed.
 *
 * We persist a `HandleRef` (see `handle-ref.ts`) — NOT the file's bytes: a test
 * input can be gigabytes, so copying it into IndexedDB is a non-starter.
 * File System Access handles ARE structured-cloneable and round-trip through IDB
 * fine; the only wrinkle is permission, which `HandleRef` handles the same way
 * `workspace-store`/`media-store` do: a library-relative ref resolves SILENTLY
 * across reloads (one library grant covers it), and a direct handle falls back
 * to a one-click re-grant. Shared browser-wide across every offline + playground
 * instance.
 */

import { idbGet, idbPut, idbDelete, STORE_INPUT_VIDEO } from './idb-store';
import { HandleRef, makeHandleRef, resolveFileRef } from './handle-ref';

const CURRENT_KEY = 'current';

interface InputVideoRecord {
  id: string; // 'current'
  ref: HandleRef;
  label: string;
  savedAt: number;
}

/** Remember the chosen input video (as a relocatable ref) for reload. */
export async function rememberInputVideo(handle: FileSystemFileHandle): Promise<void> {
  const ref = await makeHandleRef(handle);
  await idbPut(STORE_INPUT_VIDEO, { id: CURRENT_KEY, ref, label: handle.name, savedAt: Date.now() });
}

/** Forget the global input video (the input card's "clear"). */
export async function forgetInputVideo(): Promise<void> {
  await idbDelete(STORE_INPUT_VIDEO, CURRENT_KEY);
}

/** The remembered file's name, or null — for the input card's re-link label. */
export async function rememberedInputVideoLabel(): Promise<string | null> {
  const rec = await idbGet<InputVideoRecord>(STORE_INPUT_VIDEO, CURRENT_KEY);
  return rec?.label ?? null;
}

/**
 * Re-open the remembered input video as a `File`. `prompt: false` (boot) only
 * queries permission — silent, so it succeeds for a library-relative ref (or a
 * handle whose permission the browser persisted) and returns null otherwise.
 * `prompt: true` (from a user gesture) requests permission if needed.
 */
export async function restoreInputVideoFile(opts: { prompt: boolean }): Promise<File | null> {
  const rec = await idbGet<InputVideoRecord>(STORE_INPUT_VIDEO, CURRENT_KEY);
  if (!rec) return null;
  const handle = await resolveFileRef(rec.ref, { mode: 'read', prompt: opts.prompt });
  if (!handle) return null;
  try {
    return await handle.getFile();
  } catch (err) {
    console.warn('[input-video-store] getFile failed', err);
    return null;
  }
}
