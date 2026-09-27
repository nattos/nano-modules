/**
 * Effect-store thumbnail cache (IndexedDB `nano-effect-thumbs`).
 *
 * One record per effect id: the baked image plus the KEY it was baked under.
 * The key folds in everything that could change the picture —
 *
 *   - the effect's bundle CONTENTS (a SHA-256 of the .wasm bytes, so a rebuilt
 *     bundle re-bakes even if a copy kept its old modification time),
 *   - the preview scenario JSON the effect declares,
 *   - the generators' drawing version (preview/generators.ts),
 *   - this cache's own format version —
 *
 * so a stale record is simply one whose key no longer matches; it is replaced
 * on the next bake. Nothing here depends on the effects' "changed in" tags.
 *
 * Every call degrades to "no cache" when IndexedDB is unavailable (private
 * windows, blocked storage): the store just bakes again next time.
 */

import { bundleUrl } from '../effect-bundles';
import { GENERATORS_VERSION } from './generators';
import { hashString } from './scenario';

const DB_NAME = 'nano-effect-thumbs';
const STORE = 'thumbs';
const FORMAT_VERSION = 1;

export interface ThumbRecord {
  effectId: string;
  key: string;
  blob: Blob;
  /** 'image' = a rendered frame; 'graph' = a modulation effect's output plot. */
  kind: 'image' | 'graph';
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'effectId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function getThumb(effectId: string): Promise<ThumbRecord | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(effectId);
      req.onsuccess = () => resolve((req.result as ThumbRecord | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putThumb(rec: ThumbRecord): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Drop every cached thumbnail (Settings / tests). */
export async function clearThumbs(): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

const bundleHashes = new Map<string, Promise<string>>();

/** SHA-256 (hex, truncated) of a bundle's .wasm bytes, memoized per session.
 *  Falls back to the URL itself when the bytes can't be read. */
export function bundleHash(bundleId: string): Promise<string> {
  let p = bundleHashes.get(bundleId);
  if (!p) {
    const url = bundleUrl(bundleId);
    p = (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return `url:${url}`;
        const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
        return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
      } catch {
        return `url:${url}`;
      }
    })();
    bundleHashes.set(bundleId, p);
  }
  return p;
}

/** Forget memoized bundle hashes (a bundle was rebuilt / reloaded). */
export function forgetBundleHashes() {
  bundleHashes.clear();
}

/** The cache key an effect's thumbnail must carry to be current. */
export function thumbKey(bundleHashHex: string, previewJson: string | undefined): string {
  return `f${FORMAT_VERSION}.g${GENERATORS_VERSION}.b${bundleHashHex}.s${hashString(previewJson ?? '')}`;
}
