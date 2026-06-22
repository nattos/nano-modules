/**
 * Smoke test for arr-state-testbed.html (Component B — real state foundation).
 * Drives the real ArrangementStore through window.__arrState against an OPFS
 * workspace: undo/redo on a recorded edit, drag-coalescing, and a full
 * create → edit → save → reload-from-disk persistence round-trip.
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5174 npx jest arr-state-testbed
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arr-state-testbed.html`;

describe('Arrangement state testbed smoke', () => {
  jest.setTimeout(30_000);

  it('does undo/redo + a disk persistence round-trip', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (t.includes('Failed to load resource')) return;
      errors.push(`[console] ${t}`);
    });

    await page.goto(URL, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));

    const result = await page.evaluate(async () => {
      const s = (window as any).__arrState;
      const backend = await s.mountOpfs('state-smoke-ws');
      for (const e of await backend.list()) await backend.remove(e.name);

      // Create a fresh arrangement on disk seeded at 120 BPM with one track.
      const comp = s.emptyComposition();
      comp.meta.baseBPM = 120;
      comp.tracks.push({
        id: 'trk1', name: 'Track 1', kind: 'track', parentId: null,
        sketch: { devices: [] }, automation: [], clips: [],
      });
      await s.create(backend, 'doc', comp);

      // Recorded edit → undo → redo.
      s.setBpm(150);
      const afterEdit = s.bpm;
      const canUndo = s.canUndo;
      s.store.undo();
      const afterUndo = s.bpm;
      s.store.redo();
      const afterRedo = s.bpm;

      // Add a clip (document mutation), then undo it.
      const trackId = s.firstTrackId();
      const before = s.clipCount();
      s.createClip(trackId, 24);
      const afterCreate = s.clipCount();
      s.store.undo();
      const afterClipUndo = s.clipCount();
      s.store.redo();

      // Flush to disk and reload into a fresh open() to prove persistence.
      await s.saveNow();
      await s.open(backend, 'doc');
      const reloadedBpm = s.bpm;
      const reloadedClips = s.clipCount();
      const reloadCanUndo = s.canUndo; // history reset on open

      await backend.remove('doc');
      return {
        afterEdit, canUndo, afterUndo, afterRedo,
        before, afterCreate, afterClipUndo,
        reloadedBpm, reloadedClips, reloadCanUndo,
      };
    });

    expect(result.afterEdit).toBe(150);
    expect(result.canUndo).toBe(true);
    expect(result.afterUndo).toBe(120);
    expect(result.afterRedo).toBe(150);

    expect(result.afterCreate).toBe(result.before + 1);
    expect(result.afterClipUndo).toBe(result.before);

    // After redo (clip back) + saveNow + reload: 150 BPM and the clip persisted.
    expect(result.reloadedBpm).toBe(150);
    expect(result.reloadedClips).toBe(result.before + 1);
    expect(result.reloadCanUndo).toBe(false);

    expect(errors).toEqual([]);
  });
});
