/**
 * Per-source media handle persistence.
 *
 * Arrangements reference video/image sources by a stable `sourceKey` (derived
 * from file metadata, never contents). The handle itself is stored here as a
 * `HandleRef` (see `handle-ref.ts`): if the media lives under a library path
 * it's kept RELATIVE to that library (so one library grant relinks all media
 * beneath it), otherwise a direct file handle.
 */

import { idbGet, idbPut, idbGetAll, idbDelete, STORE_MEDIA } from '../../../state/idb-store';
import { deriveSourceKey } from '../../../video/profile-store';
import { HandleRef, makeHandleRef, resolveFileRef } from '../../../state/handle-ref';
import { deserializeHandle, type PathsFileHandle } from '../../../state/paths';
import type { MediaDocRef } from '../model/composition';

export interface MediaHandleRecord {
  sourceKey: string; // 'name|size|lastModified'
  /** Library-relative or direct reference to the media file. */
  ref: HandleRef;
  name: string;
  size: number;
  lastModified: number;
  linkedAt: number;
}

/**
 * Link a media file handle. Returns the stable `sourceKey` an arrangement
 * stores, plus the portable `docRef` to write into `clip.source.ref` — null
 * when the file isn't under any library path, in which case only this
 * per-profile record can find it again. Idempotent: relinking the same file
 * overwrites the record.
 */
export async function linkMedia(
  handle: PathsFileHandle,
): Promise<{ sourceKey: string; docRef: MediaDocRef | null }> {
  const { sourceKey, file } = await deriveSourceKey(handle);
  const ref = await makeHandleRef(handle);
  const rec: MediaHandleRecord = {
    sourceKey,
    ref,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    linkedAt: Date.now(),
  };
  await idbPut(STORE_MEDIA, rec);
  return {
    sourceKey,
    docRef: ref.kind === 'lib' ? { libraryId: ref.libraryId, path: ref.path } : null,
  };
}

/** Look up the persisted record for a sourceKey, or null on miss. */
export async function resolveMedia(sourceKey: string): Promise<MediaHandleRecord | null> {
  const rec = (await idbGet<MediaHandleRecord>(STORE_MEDIA, sourceKey)) ?? null;
  // Structured clone strips an fs-backed handle's prototype — rehydrate before
  // anyone tries to call a method on it.
  if (rec?.ref?.kind === 'direct') {
    const handle = deserializeHandle(rec.ref.handle);
    if (!handle) return null;
    rec.ref = { ...rec.ref, handle };
  }
  return rec;
}

/**
 * Resolve a sourceKey to a readable `File`, re-granting permission if needed.
 * Returns null when the handle is missing or permission is declined (the UI
 * surfaces a "relink media" affordance in that case). Must run from a user
 * gesture if a permission prompt may appear.
 */
export async function openMedia(sourceKey: string): Promise<File | null> {
  const rec = await resolveMedia(sourceKey);
  if (!rec) return null;
  const fh = await resolveFileRef(rec.ref, { prompt: true, mode: 'read' });
  if (!fh) return null;
  try {
    return await fh.getFile();
  } catch {
    return null;
  }
}

/** All linked media (for a workspace media manager / relink UI). */
export async function listMedia(): Promise<MediaHandleRecord[]> {
  return idbGetAll<MediaHandleRecord>(STORE_MEDIA);
}

/** Drop a media link. */
export async function unlinkMedia(sourceKey: string): Promise<void> {
  await idbDelete(STORE_MEDIA, sourceKey);
}
