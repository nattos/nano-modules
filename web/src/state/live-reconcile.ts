/**
 * Pure live-mode cache-vs-canonical reconciliation logic — decides whether a
 * cached-but-unconfirmed sketch can be silently replaced by the barrel's
 * canonical snapshot, or whether the two have genuinely diverged and need a
 * user decision (see `views/reconcile-dialog.ts`). Kept side-effect free so
 * it can be unit tested without an engine/IDB, mirroring `resolume-mode.ts`.
 */

import type { Sketch } from '../sketch-types';
import type { LiveCacheRecord } from './live-cache-store';

/**
 * Deep, key-order-stable JSON string of `sketch` with the storage-only
 * metadata fields (`lastModified`, `engineVersion`) removed — so cached-vs-
 * canonical content compares equal regardless of key insertion order (an
 * IDB-loaded object vs. a freshly `JSON.parse`d wire payload can differ in
 * order despite meaning the same thing). Array order is preserved
 * (semantically meaningful for `chain`/`wires`).
 *
 * `engineVersion` MUST be stripped: `saveLiveCacheInstance` stamps it onto
 * every stored sketch, but the canonical snapshot from the barrel
 * (`coerceSketch`) never carries it — leaving it in would make
 * `sketchContentEqual` always false for a real IDB row, so a dirty cache that
 * actually matches canonical would wrongly open the conflict dialog instead
 * of silently adopting.
 */
export function stripForCompare(sketch: Sketch): string {
  const { lastModified: _lastModified, engineVersion: _engineVersion, ...rest } =
    sketch as Sketch & { lastModified?: number; engineVersion?: number };
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sketchContentEqual(a: Sketch, b: Sketch): boolean {
  return stripForCompare(a) === stripForCompare(b);
}

export type RecencySide = 'cached' | 'canonical' | 'unknown';

/**
 * Which side is more recent, purely from `lastModified` timestamps —
 * display/recommendation only, NEVER the silent-adopt gate: client clocks
 * can disagree, so this must not decide anything by itself. 'unknown' when
 * either side lacks a timestamp (e.g. a pre-existing composition saved
 * before this field existed) or they're equal.
 */
export function moreRecent(cachedLM: number | undefined, canonicalLM: number | undefined): RecencySide {
  if (cachedLM == null || canonicalLM == null || cachedLM === canonicalLM) return 'unknown';
  return cachedLM > canonicalLM ? 'cached' : 'canonical';
}

export type ReconcileAction = 'adopt-canonical' | 'conflict';

export interface ReconcileResult {
  action: ReconcileAction;
  /** Only meaningful when `action` is 'conflict' — which side to suggest
   *  (the safer 'canonical' default when recency is unknown). */
  recommended: RecencySide;
}

/**
 * Decide whether the barrel's canonical snapshot can silently replace the
 * cached sketch, or whether they've diverged and need a user decision.
 *
 * Gated on `cached.dirty` (has local edits not confirmed pushed), NOT on
 * content equality or timestamps: a clean cache always adopts (it was only
 * ever mirroring the barrel); a dirty cache whose content happens to exactly
 * match canonical also adopts silently (nothing meaningful to ask about).
 */
export function reconcileDecision(opts: {
  cached: LiveCacheRecord | null;
  canonical: Sketch;
}): ReconcileResult {
  const { cached, canonical } = opts;
  if (!cached || !cached.dirty || sketchContentEqual(cached.sketch, canonical)) {
    return { action: 'adopt-canonical', recommended: 'canonical' };
  }
  const recency = moreRecent(cached.sketch.lastModified, canonical.lastModified);
  return { action: 'conflict', recommended: recency === 'cached' ? 'cached' : 'canonical' };
}
