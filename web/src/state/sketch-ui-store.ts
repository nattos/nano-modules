/**
 * Per-sketch UI-only editor state.
 *
 * A small, extensible bag of view-local preferences keyed by sketch id — the
 * kind of cosmetic state that should survive reloads but has no place in the
 * sketch document itself (it isn't undoable and never crosses the worker
 * boundary). Today it holds the editor's last scroll offset; add fields to
 * `SketchUiState` as more per-sketch UI bits want persisting.
 *
 * Sketch ids are the same across every editing surface (`user:<uuid>`,
 * `default:<effectId>`, `pg:<uuid>`, live barrel UUIDs), so a sketch keeps its
 * scroll position whether it's opened in effect-dev, live, or playground.
 *
 * Writes merge into an in-memory cache so a `save` of one field never clobbers
 * another that a prior session wrote — callers should `load` a sketch before
 * saving it (the editor does: it restores scroll on open, which hydrates the
 * cache, before any save fires).
 */

import { idbGet, idbPut, idbDelete, STORE_SKETCH_UI } from './idb-store';

/** UI-only, per-sketch view preferences. Extend freely — every field optional. */
export interface SketchUiState {
  /** Last vertical scroll offset of the columns editor, in px. */
  scrollTop?: number;
  /** Last horizontal scroll offset of the columns editor, in px. */
  scrollLeft?: number;
}

interface SketchUiStateRecord extends SketchUiState {
  /** Sketch id this state belongs to. */
  id: string;
  updatedAt: number;
}

// Session cache: the last record we read or wrote per sketch. Lets `save` merge
// without a DB round-trip and keeps partial updates from clobbering each other.
const cache = new Map<string, SketchUiStateRecord>();

export async function loadSketchUiState(id: string): Promise<SketchUiState | null> {
  const cached = cache.get(id);
  if (cached) return cached;
  try {
    const rec = await idbGet<SketchUiStateRecord>(STORE_SKETCH_UI, id);
    if (rec) cache.set(id, rec);
    return rec ?? null;
  } catch (err) {
    console.warn('[sketch-ui-store] load failed', id, err);
    return null;
  }
}

/** Merge `patch` into the sketch's stored UI state (read-modify-write via cache). */
export async function saveSketchUiState(id: string, patch: Partial<SketchUiState>): Promise<void> {
  const prev = cache.get(id) ?? { id, updatedAt: 0 };
  const next: SketchUiStateRecord = { ...prev, ...patch, id, updatedAt: Date.now() };
  cache.set(id, next);
  try {
    await idbPut(STORE_SKETCH_UI, next);
  } catch (err) {
    console.warn('[sketch-ui-store] save failed', id, err);
  }
}

export async function deleteSketchUiState(id: string): Promise<void> {
  cache.delete(id);
  try {
    await idbDelete(STORE_SKETCH_UI, id);
  } catch (err) {
    console.warn('[sketch-ui-store] delete failed', id, err);
  }
}
