/**
 * Live-mode instance CRUD on top of `idb-store` — the offline cache for
 * Resolume Live mode. Mirrors `playground-store.ts` but over its own object
 * store: one row per barrel instance this browser has edited, so a dropped
 * connection or a Resolume crash doesn't lose in-progress edits (though it
 * can't recover changes made directly in Resolume itself).
 *
 * `dirty` distinguishes "has local edits not yet confirmed matching/pushed to
 * canonical" from a plain mirror of whatever the barrel last held — it's what
 * `state/live-reconcile.ts` uses to decide silent-adopt vs. conflict-dialog,
 * NOT the `lastModified` timestamp (client clocks can disagree; the
 * timestamp is display/recommendation only).
 *
 * Save scheduling is the controller's job (debounced, change-gated, from the
 * post-record hook); never a MobX reaction.
 */

import { toJS } from 'mobx';
import type { Sketch } from '../sketch-types';
import { ENGINE_VERSION } from '../version';
import { idbGetAll, idbGet, idbPut, idbDelete, STORE_LIVE_CACHE } from './idb-store';

export interface LiveCacheRecord {
  key: string;      // barrel instance UUID (routing key)
  label: string;    // last-known instance label
  sketch: Sketch;
  updatedAt: number;
  /** Has local edits not yet confirmed pushed to / matching canonical. */
  dirty: boolean;
  /**
   * Composition generation (`UserSettings.liveSessionGeneration`) this key
   * was last confirmed a member of, via `/global/composition_barrel_ids`.
   * Offline-mode loading filters to the LATEST generation only — see
   * `types.ts`'s `liveSessionGeneration` doc comment. `undefined` for rows
   * written before this field existed; treated as "unknown generation" by
   * callers (never filtered out on that basis alone).
   */
  session?: number;
}

export async function loadAllLiveCacheInstances(): Promise<LiveCacheRecord[]> {
  const records = await idbGetAll<LiveCacheRecord>(STORE_LIVE_CACHE);
  return records.filter((r) => r && typeof r.key === 'string' && !!r.sketch);
}

export async function loadLiveCacheInstance(key: string): Promise<LiveCacheRecord | undefined> {
  return idbGet<LiveCacheRecord>(STORE_LIVE_CACHE, key);
}

export async function saveLiveCacheInstance(
  key: string, label: string, sketch: Sketch, dirty: boolean, session?: number,
): Promise<void> {
  // toJS + JSON round-trip to avoid sending MobX proxies into IDB.
  const safe = JSON.parse(JSON.stringify(toJS(sketch)));
  safe.engineVersion = ENGINE_VERSION;
  const record: LiveCacheRecord = {
    key, label, sketch: safe, updatedAt: Date.now(), dirty,
  };
  if (session != null) record.session = session;
  await idbPut(STORE_LIVE_CACHE, record satisfies LiveCacheRecord);
}

/**
 * Stamp an EXISTING row's `session` generation without touching its sketch/
 * dirty/updatedAt — the composition-scan pass calls this for every key it
 * confirms is still in the loaded composition. No-op if the row doesn't
 * exist yet (nothing to stamp; it'll get a real `session` on its first
 * `saveLiveCacheInstance`).
 */
export async function touchLiveCacheSession(key: string, session: number): Promise<void> {
  const existing = await idbGet<LiveCacheRecord>(STORE_LIVE_CACHE, key);
  if (!existing || existing.session === session) return;
  await idbPut(STORE_LIVE_CACHE, { ...existing, session } satisfies LiveCacheRecord);
}

export async function deleteLiveCacheInstance(key: string): Promise<void> {
  await idbDelete(STORE_LIVE_CACHE, key);
}
