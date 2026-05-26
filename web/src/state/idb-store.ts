/**
 * Tiny Promise-wrapped IndexedDB helper.
 *
 * Two object stores:
 *   - `projects` — keyPath 'id', stores `{ id: string, sketch: Sketch, updatedAt: number }`
 *   - `settings` — keyPath 'id', singleton (`id: 'settings'`)
 *
 * Same-origin: both entry pages (effect-ide and resolume) share this database.
 */

const DB_NAME = 'nano-modules';
const DB_VERSION = 3;

export const STORE_PROJECTS = 'projects';
export const STORE_SETTINGS = 'settings';
/**
 * Last image/video file dropped onto each sketch's `texture_input`. Keyed by
 * sketch id. Stores the raw `Blob` plus a `kind` discriminator.
 */
export const STORE_SKETCH_INPUTS = 'sketchInputs';
/**
 * Source-level cost profile for the video playback service. Keyed by a
 * derived sourceKey (e.g. 'name|size|lastModified') that the service
 * computes without reading file contents. Holds codec/file timing EWMAs
 * and the optional FileSystemFileHandle for restore.
 */
export const STORE_VIDEO_SOURCE_PROFILES = 'videoSourceProfiles';
/**
 * Clip-level (source+salt) access pattern profile. Captures the inferred
 * mode plus mode-specific cache hints (loop range, hot frames, stride).
 */
export const STORE_VIDEO_CLIP_PROFILES = 'videoClipProfiles';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SKETCH_INPUTS)) {
        db.createObjectStore(STORE_SKETCH_INPUTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_VIDEO_SOURCE_PROFILES)) {
        db.createObjectStore(STORE_VIDEO_SOURCE_PROFILES, { keyPath: 'sourceKey' });
      }
      if (!db.objectStoreNames.contains(STORE_VIDEO_CLIP_PROFILES)) {
        db.createObjectStore(STORE_VIDEO_CLIP_PROFILES, { keyPath: 'clipKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(store: string, value: any): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}
