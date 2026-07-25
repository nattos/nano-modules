/**
 * A sequence clip survives a DISK round-trip (arr-state-testbed.html, real
 * ArrangementStore over an OPFS workspace).
 *
 * The interior lane is a real `Track` living inside a `Clip`, so it rides two
 * code paths nothing else does: `deserializeComposition`'s lane-shape
 * normalization and `repairIds`' uniqueness scan. Both are load-time nets that
 * can only fire against a file. What must hold after reopen:
 *   - the interior survives with its sub-clips, spans and order intact;
 *   - the LANE ID is byte-stable — instance keys (`track_<laneId>_<devId>`),
 *     `sceneLaunchState[laneId]` and layer targets are all keyed by it, so a
 *     re-mint on load would silently orphan the lane's FX bus;
 *   - the sub-clips did NOT also land on the top-level track (the duplicate-id
 *     class that makes `Builder::push` drop instances and render black).
 *
 *   ARR_BASE_URL=http://localhost:5174 npx jest arr-state-testbed-sequence
 */

const BASE = process.env.ARR_BASE_URL || process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arr-state-testbed.html`;

describe('Sequence clips survive save + reopen', () => {
  jest.setTimeout(30_000);

  it('round-trips the interior lane, its ids and its spans through OPFS', async () => {
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
      const store = s.store;
      const backend = await s.mountOpfs('state-seq-ws');
      for (const e of await backend.list()) await backend.remove(e.name);

      const comp = s.emptyComposition();
      comp.tracks.push({
        id: 'trk1', name: 'Track 1', kind: 'track', parentId: null,
        sketch: { devices: [] }, automation: [], clips: [],
      });
      await s.create(backend, 'seqdoc', comp);

      // Two clips, one carrying a device (so the interior has a real chain to
      // re-id), consolidated into a sequence over [0, 8).
      const mk = (start: number, len: number) => {
        const [, tId, cId] = store.createEmptyClip('trk1', start, len).split('/');
        return { tId, cId };
      };
      const a = mk(0, 4);
      const b = mk(4, 4);
      // A hand-built device: the testbed page mounts no plugin catalog, so
      // addClipDeviceType (which resolves through it) would silently no-op.
      store.addDeviceToClip('trk1', a.cId, {
        id: 'dev_fixed', moduleType: 'color.exposure', name: 'Exposure',
        capabilities: ['time_independent'], state: {},
      });
      store.setTimeSelection(0, 8, ['trk1']);
      store.consolidateSelection();

      const snap = () => {
        const track = store.composition.tracks.find((t: any) => t.id === 'trk1');
        const seq = track.clips.find((c: any) => c.kind === 'sequence');
        return {
          topLevelClipIds: track.clips.map((c: any) => c.id),
          seqId: seq?.id ?? null,
          seqSpan: seq ? [seq.startBeat, seq.lengthBeat] : null,
          laneId: seq?.sequence?.id ?? null,
          laneKind: seq?.sequence?.kind ?? null,
          interior: (seq?.sequence?.clips ?? []).map((c: any) => ({
            id: c.id, start: c.startBeat, len: c.lengthBeat,
            devs: (c.sketch?.devices ?? []).map((d: any) => `${d.id}:${d.moduleType}`),
          })),
        };
      };
      const before = snap();

      await s.saveNow();
      await s.open(backend, 'seqdoc');
      const after = snap();

      await backend.remove('seqdoc');
      return { before, after, subIds: [a.cId, b.cId] };
    });

    const { before, after } = result;

    // The consolidate itself landed (guards against a vacuous round-trip).
    expect(before.seqId).toBeTruthy();
    expect(before.interior.map((c: any) => c.id)).toEqual(result.subIds);
    expect(before.topLevelClipIds).toEqual([before.seqId]);

    // ...and reopening from disk reproduces it exactly.
    expect(after.seqId).toBe(before.seqId);
    expect(after.seqSpan).toEqual([0, 8]);
    expect(after.laneId).toBe(before.laneId); // stable — instance keys depend on it
    expect(after.laneKind).toBe('track');
    expect(after.interior).toEqual(before.interior);
    // The interior device rode along with its id intact (instance keys are
    // `clip_<subId>_<devId>` — a re-mint on load would rebuild the chain).
    expect(after.interior[0].devs).toEqual(['dev_fixed:color.exposure']);

    // The sub-clips live ONLY inside the lane — never duplicated onto the track.
    expect(after.topLevelClipIds).toEqual([after.seqId]);
    for (const sub of result.subIds) expect(after.topLevelClipIds).not.toContain(sub);

    expect(errors).toEqual([]);
  });
});
