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
/**
 * Arrangement workspace directory handles (File System Access API). Keyed by
 * 'current' for the active workspace, plus per-path recents. Stores the raw
 * `FileSystemDirectoryHandle` (structured-cloneable) so we can re-mount the
 * same on-disk folder across reloads after a permission re-grant.
 */
export const STORE_WORKSPACE = 'workspace';
/**
 * Per-source media file handles for arrangement clips. Keyed by a stable
 * sourceKey ('name|size|lastModified'). Stores the `FileSystemFileHandle` so
 * media that lives anywhere on disk (outside the workspace) can be relinked
 * after reload — mirrors the video profile-store handle pattern.
 */
export const STORE_MEDIA = 'mediaHandles';
/**
 * Global "library paths" — user-chosen root directories the app can resolve
 * files under. Keyed by a generated `id`. Stores the `FileSystemDirectoryHandle`
 * plus a label. File/workspace references express themselves RELATIVE to a
 * library path (id + subpath) when possible, resolved via `dir.resolve()`, so a
 * single permission grant on the library root unlocks everything beneath it.
 */
export const STORE_LIBRARY = 'libraryPaths';
/**
 * Global (browser-wide, cross-sketch) help-text overrides. Keyed by a composite
 * `key` of `${effectTypeId}|${slotPath}` — the user's customized markdown for a
 * given effect's help slot, shared across every sketch and surface. Stores
 * `{ key, text }`. Per-sketch (local) overrides live in the sketch instead.
 */
export const STORE_FIELD_DOCS = 'fieldDocs';
/**
 * Playground instances — the local shared-server playground's fake barrel
 * instances (`/resolume/?playground`). Keyed by `pg:<uuid>`, stores
 * `{ id, label, sketch, updatedAt }`. Expressly separate from `projects`
 * (the effect-IDE sketches): the playground is its own environment and must
 * never read or write effect-IDE state.
 */
export const STORE_PLAYGROUND = 'playgroundInstances';
/**
 * Live-mode composition cache — the last-known sketch for each barrel
 * instance this browser has edited, keyed by the instance's stable UUID.
 * Loaded readonly at Live-mode boot (before the WS connects) so there's
 * something to show immediately, and compared against the canonical
 * snapshot once connected (see `state/live-reconcile.ts`). Expressly
 * separate from `playgroundInstances`: same shape, different environment.
 */
export const STORE_LIVE_CACHE = 'liveCache';
/**
 * The single, global "test input" video for offline/playground mode — one
 * `FileSystemFileHandle` (keyed 'current') the user picks to feed every running
 * instance a stand-in for Resolume's live layer feed. Restored silently at app
 * start. Shared browser-wide across all offline + playground instances.
 */
export const STORE_INPUT_VIDEO = 'inputVideo';
/**
 * MIDI device library — user-owned device instances (forks of code-registered
 * templates), keyed by instance uuid. App-level and cross-sketch (wires
 * reference instances by `midi:<uuid>`), NOT undoable, includes soft-deleted
 * rows. See `state/midi-device-store.ts` / `state/midi-controller.ts`.
 */
export const STORE_MIDI_DEVICES = 'midiDevices';
/**
 * Per-sketch UI-only editor state, keyed by sketch id (`user:<uuid>`,
 * `default:<effectId>`, `pg:<uuid>`, or a live barrel UUID). A small bag of
 * view-local preferences — currently the editor's last scroll offset — that
 * should survive reloads and follow a sketch across the effect-dev / live /
 * playground surfaces (they all edit the same sketch ids). Purely cosmetic,
 * NOT part of the sketch document, NOT undoable. See `state/sketch-ui-store.ts`.
 */
export const STORE_SKETCH_UI = 'sketchUiState';

/** Every store + its keyPath. `ensureStores` creates any that are missing. */
const STORE_KEYPATHS: Record<string, string> = {
  [STORE_PROJECTS]: 'id',
  [STORE_PLAYGROUND]: 'id',
  [STORE_LIVE_CACHE]: 'key',
  [STORE_SETTINGS]: 'id',
  [STORE_SKETCH_INPUTS]: 'id',
  [STORE_VIDEO_SOURCE_PROFILES]: 'sourceKey',
  [STORE_VIDEO_CLIP_PROFILES]: 'clipKey',
  [STORE_WORKSPACE]: 'id',
  [STORE_MEDIA]: 'sourceKey',
  [STORE_LIBRARY]: 'id',
  [STORE_FIELD_DOCS]: 'key',
  [STORE_INPUT_VIDEO]: 'id',
  [STORE_MIDI_DEVICES]: 'id',
  [STORE_SKETCH_UI]: 'id',
};

function ensureStores(db: IDBDatabase) {
  for (const [name, keyPath] of Object.entries(STORE_KEYPATHS)) {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the DB and guarantee every store exists. Rather than a fixed version
 * number (which silently breaks when a dev/HMR session cached an older
 * connection, or when stores are added), we open at the DB's current version,
 * then if any required store is missing force exactly one version bump to add
 * it. This self-heals a DB that predates a newly-added store.
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const probe = indexedDB.open(DB_NAME); // current version, or v1 if brand new
    probe.onupgradeneeded = () => ensureStores(probe.result); // first-ever create
    probe.onerror = () => reject(probe.error);
    probe.onsuccess = () => {
      const db = probe.result;
      const missing = Object.keys(STORE_KEYPATHS).some((s) => !db.objectStoreNames.contains(s));
      if (!missing) { resolve(db); return; }
      // Reopen one version higher to run an upgrade that adds the missing stores.
      const next = db.version + 1;
      db.close();
      const up = indexedDB.open(DB_NAME, next);
      up.onupgradeneeded = () => ensureStores(up.result);
      up.onsuccess = () => resolve(up.result);
      up.onerror = () => reject(up.error);
      up.onblocked = () => reject(new Error('IndexedDB upgrade blocked — close other tabs of this app'));
    };
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
