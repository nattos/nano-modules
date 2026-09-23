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
import { HandleRef, makeHandleRef, resolveFileRef } from '../../../state/handle-ref';
import { libraryPaths } from '../../../state/library-paths';
import {
  deserializeHandle,
  openMediaSource,
  type MediaSource,
  type PathsFileHandle,
} from '../../../state/paths';
import type { MediaDocFile, MediaDocRef } from '../model/composition';

export interface MediaHandleRecord {
  sourceKey: string; // 'name|size|lastModified'
  /** Library-relative or direct reference to the media file. */
  ref: HandleRef;
  name: string;
  size: number;
  lastModified: number;
  linkedAt: number;
}

/** What {@link linkMedia} hands back for the clip it's about to create. */
export interface LinkedMedia {
  /** The stable key an arrangement stores (`name|size|lastModified`). */
  sourceKey: string;
  /** Library-relative ref for `clip.source.ref` — null when the file isn't
   *  under any library path. */
  docRef: MediaDocRef | null;
  /** Real location for `clip.source.file` — null on the web, which never
   *  learns one. */
  docFile: MediaDocFile | null;
  /** The file, opened for ranged reads (import it with `importMedia`). */
  media: MediaSource;
}

/**
 * Link a media file handle: persist the per-profile record and work out every
 * binding the document can carry. Idempotent: relinking the same file
 * overwrites the record.
 */
export async function linkMedia(handle: PathsFileHandle): Promise<LinkedMedia> {
  // openMediaSource, not getFile(): under Electron a File means reading the
  // whole (possibly multi-GB) file into memory.
  const media = await openMediaSource(handle);
  const sourceKey = `${media.name}|${media.size}|${media.lastModified}`;
  const ref = await makeHandleRef(handle);
  const rec: MediaHandleRecord = {
    sourceKey,
    ref,
    name: media.name,
    size: media.size,
    lastModified: media.lastModified,
    linkedAt: Date.now(),
  };
  await idbPut(STORE_MEDIA, rec);
  let docRef: MediaDocRef | null = null;
  if (ref.kind === 'lib') {
    const label = libraryPaths.get(ref.libraryId)?.label;
    docRef = { libraryId: ref.libraryId, path: ref.path, ...(label ? { libraryLabel: label } : {}) };
  }
  return {
    sourceKey,
    docRef,
    docFile: media.absPath ? { abs: media.absPath } : null,
    media,
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
 * Resolve a sourceKey to its file handle, re-granting permission if needed.
 * Null when the record is missing, the file is gone, or permission is declined
 * (the UI surfaces a "relink media" affordance then). Must run from a user
 * gesture if a permission prompt may appear.
 */
export async function openMediaHandle(sourceKey: string): Promise<PathsFileHandle | null> {
  const rec = await resolveMedia(sourceKey);
  if (!rec) return null;
  return resolveFileRef(rec.ref, { prompt: true, mode: 'read' });
}

/** Resolve a sourceKey to a readable `File` (see {@link openMediaHandle}). */
export async function openMedia(sourceKey: string): Promise<File | null> {
  const fh = await openMediaHandle(sourceKey);
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
