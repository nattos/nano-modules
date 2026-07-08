/**
 * Persist + restore the single, global "test input" video used in
 * offline/playground mode as a stand-in for Resolume's live layer feed.
 *
 * We store the file's BYTES as a `Blob` (keyed 'current'), NOT a
 * `FileSystemFileHandle`: File System Access permission does not survive a page
 * reload without a fresh user-gesture grant, so a stored handle can't be
 * re-read silently at boot. A Blob is structured-cloneable, so IndexedDB
 * round-trips it and restore re-decodes with no prompt — the same approach as
 * the per-sketch `sketch-input-store`. Shared browser-wide across every offline
 * + playground instance. (The originating handle is kept too, purely as a
 * best-effort future re-link hint; restore never depends on it.)
 */

import { idbGet, idbPut, idbDelete, STORE_INPUT_VIDEO } from './idb-store';

const CURRENT_KEY = 'current';

interface InputVideoRecord {
  id: string; // 'current'
  blob: Blob;
  label: string;
  mimeType: string;
  savedAt: number;
  /** Best-effort re-link hint; restore does not use it (permission lapses). */
  handle?: FileSystemFileHandle;
}

/**
 * Remember the chosen input video (its bytes) so it re-loads after reload.
 * `file` is any dropped/picked File; `handle` (when a picker/drop provides one)
 * is stored only as a future re-link hint.
 */
export async function rememberInputVideo(file: File, handle?: FileSystemFileHandle): Promise<void> {
  // Copy into a plain Blob so IDB stores the bytes (a File subclass is fine too,
  // but this drops any lingering handle association from the File itself).
  const blob = new Blob([await file.arrayBuffer()], { type: file.type });
  const rec: InputVideoRecord = {
    id: CURRENT_KEY, blob, label: file.name, mimeType: file.type, savedAt: Date.now(), handle,
  };
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
 * Re-open the remembered input video as a `File`, reconstructed from the stored
 * bytes — no permission prompt, safe at boot. Returns null if none is stored.
 */
export async function restoreInputVideoFile(): Promise<File | null> {
  const rec = await idbGet<InputVideoRecord>(STORE_INPUT_VIDEO, CURRENT_KEY);
  if (!rec) return null;
  try {
    return new File([rec.blob], rec.label || 'input', { type: rec.mimeType || rec.blob.type });
  } catch (err) {
    console.warn('[input-video-store] restore failed', err);
    return null;
  }
}
