/**
 * Per-sketch input file store.
 *
 * Persists the last image or video file dropped onto a sketch's
 * `texture_input`, keyed by sketch id. `Blob` instances are
 * structured-cloneable, so IndexedDB stores them directly — on retrieval
 * we get a fresh Blob the browser can re-decode.
 *
 * The file source (image or video) is preserved across reloads so a
 * project that was set up with a particular video keeps that video the
 * next time you open it.
 */

import { idbDelete, idbGet, idbPut, STORE_SKETCH_INPUTS } from './idb-store';

export type SketchInputKind = 'image' | 'video';

export interface SketchInputRecord {
  /** Sketch id this file belongs to (`user:<uuid>` or `default:<effectId>`). */
  id: string;
  /** Decoded media type, derived from the original file's MIME type. */
  kind: SketchInputKind;
  /** Original filename, for debugging / display. */
  fileName: string;
  /** Original MIME type, e.g. `image/jpeg`, `video/mp4`. */
  mimeType: string;
  /** The file payload. Browsers store this as a Blob with referenced bytes. */
  blob: Blob;
  updatedAt: number;
}

export async function loadSketchInput(id: string): Promise<SketchInputRecord | null> {
  try {
    const rec = await idbGet<SketchInputRecord>(STORE_SKETCH_INPUTS, id);
    return rec ?? null;
  } catch (err) {
    console.warn('[sketch-input-store] load failed', id, err);
    return null;
  }
}

export async function saveSketchInput(id: string, file: File): Promise<void> {
  const kind: SketchInputKind | null = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : null;
  if (!kind) {
    console.warn('[sketch-input-store] unsupported file type:', file.type);
    return;
  }
  const record: SketchInputRecord = {
    id,
    kind,
    fileName: file.name,
    mimeType: file.type,
    // Plain Blob copy — File extends Blob, so storing it directly works,
    // but we strip the File-specific metadata to avoid surprises across
    // browsers' IDB structured-clone implementations.
    blob: new Blob([file], { type: file.type }),
    updatedAt: Date.now(),
  };
  await idbPut(STORE_SKETCH_INPUTS, record);
}

export async function deleteSketchInput(id: string): Promise<void> {
  await idbDelete(STORE_SKETCH_INPUTS, id);
}
