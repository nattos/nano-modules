import { describe, it, expect, vi, beforeEach } from 'vitest';

// Back the store with a tiny in-memory IDB so merge/cache behavior is observable
// without a real IndexedDB.
const db = new Map<string, any>();
const puts: any[] = [];
vi.mock('./idb-store', () => ({
  STORE_SKETCH_UI: 'sketchUiState',
  idbGet: (_store: string, key: string) => Promise.resolve(db.get(key)),
  idbPut: (_store: string, value: any) => { puts.push(value); db.set(value.id, value); return Promise.resolve(); },
  idbDelete: (_store: string, key: string) => { db.delete(key); return Promise.resolve(); },
}));

import { loadSketchUiState, saveSketchUiState, deleteSketchUiState } from './sketch-ui-store';

describe('sketch-ui-store', () => {
  beforeEach(() => { db.clear(); puts.length = 0; });

  it('persists a scroll offset keyed by sketch id and reads it back', async () => {
    await saveSketchUiState('user:a', { scrollTop: 120, scrollLeft: 4 });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ id: 'user:a', scrollTop: 120, scrollLeft: 4 });
    expect(typeof puts[0].updatedAt).toBe('number');

    const state = await loadSketchUiState('user:a');
    expect(state).toMatchObject({ scrollTop: 120, scrollLeft: 4 });
  });

  it('merges partial saves rather than clobbering other fields', async () => {
    await saveSketchUiState('user:b', { scrollTop: 50, scrollLeft: 10 });
    // A later save of only one axis must preserve the other.
    await saveSketchUiState('user:b', { scrollTop: 200 });
    const state = await loadSketchUiState('user:b');
    expect(state).toMatchObject({ scrollTop: 200, scrollLeft: 10 });
  });

  it('serves a previously loaded record from cache without re-reading IDB', async () => {
    // Seed IDB directly, load once (hydrates cache), then mutate IDB out of band.
    db.set('user:c', { id: 'user:c', scrollTop: 7, updatedAt: 1 });
    const first = await loadSketchUiState('user:c');
    expect(first).toMatchObject({ scrollTop: 7 });
    db.set('user:c', { id: 'user:c', scrollTop: 999, updatedAt: 2 });
    // Cache wins — we don't re-hit IDB for a known key.
    const second = await loadSketchUiState('user:c');
    expect(second).toMatchObject({ scrollTop: 7 });
  });

  it('returns null for an unknown sketch', async () => {
    expect(await loadSketchUiState('user:missing')).toBeNull();
  });

  it('deletes both the cache entry and the IDB row', async () => {
    await saveSketchUiState('user:d', { scrollTop: 30 });
    await deleteSketchUiState('user:d');
    expect(db.has('user:d')).toBe(false);
    expect(await loadSketchUiState('user:d')).toBeNull();
  });
});
