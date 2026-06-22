import { describe, it, expect } from 'vitest';
import { ThumbnailManager } from './thumbnail-manager';
import { MockThumbStore, identityCodec } from './thumbnail-store';
import type { ThumbnailProducer } from './thumbnail-cache';

/** Fake decoder: counts decodes, returns a stable string per (source, frame). */
function fakeDecoder() {
  let count = 0;
  const decoder: ThumbnailProducer<string> = {
    async produce(sourceKey, frame) {
      count++;
      return `${sourceKey}:${frame}`;
    },
  };
  return { decoder, get count() { return count; } };
}

/** Flush microtask + macrotask chains so async fills/persists settle. */
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function makeMgr(opts?: { baseCapacity?: number }) {
  const store = new MockThumbStore<string>();
  const dec = fakeDecoder();
  const mgr = new ThumbnailManager<string, string>(
    dec.decoder,
    store,
    identityCodec<string>(),
    { baseCapacity: opts?.baseCapacity ?? 256, mip: { baseStride: 1 } },
  );
  return { mgr, store, dec };
}

describe('ThumbnailManager', () => {
  it('a window view prefetches the range into memory and persists it', async () => {
    const { mgr, store } = makeMgr();
    mgr.setView('strip', { sourceKey: 's', level: 0, startFrame: 0, endFrame: 5, pattern: 'window' });
    await flush();

    for (let f = 0; f <= 5; f++) expect(mgr.has('s', f, 0)).toBe(true);
    expect(mgr.stats().decodes).toBe(6);
    expect(store.writes).toBe(6); // each decoded tile persisted to the warm tier
  });

  it('cold restart serves from the store WITHOUT re-decoding', async () => {
    const { mgr, store } = makeMgr();
    mgr.setView('strip', { sourceKey: 's', level: 0, startFrame: 0, endFrame: 5, pattern: 'window' });
    await flush();
    const decodesAfterWarm = mgr.stats().decodes;
    const readsBefore = store.reads;

    mgr.clearMemory(); // model an app restart: hot tier gone, store intact
    expect(mgr.has('s', 0, 0)).toBe(false);

    mgr.setView('strip', { sourceKey: 's', level: 0, startFrame: 0, endFrame: 5, pattern: 'window' });
    await flush();

    expect(mgr.has('s', 3, 0)).toBe(true);
    expect(mgr.stats().decodes).toBe(decodesAfterWarm); // no new decodes
    expect(store.reads).toBeGreaterThan(readsBefore); // refilled from disk tier
  });

  it('peek returns the exact tile when resident', async () => {
    const { mgr } = makeMgr();
    mgr.setView('strip', { sourceKey: 's', level: 0, startFrame: 0, endFrame: 4, pattern: 'window' });
    await flush();
    const hit = mgr.peek('s', 3, 0);
    expect(hit).toEqual({ value: 's:3', frame: 3, exact: true, distanceFrames: 0 });
  });

  it('peek stretches: serves the nearest cached substitute from another level', async () => {
    const { mgr } = makeMgr();
    // Only a COARSE level (stride 4) is resident: frames 0,4,8,12.
    mgr.setView('coarse', { sourceKey: 's', level: 2, startFrame: 0, endFrame: 12, pattern: 'window' });
    await flush();

    // Ask for a FINE tile at frame 5 that was never prefetched.
    const hit = mgr.peek('s', 5, 0);
    expect(hit).not.toBeNull();
    expect(hit!.exact).toBe(false);
    expect(hit!.frame).toBe(4); // nearest cached of {0,4,8,12}
    expect(hit!.distanceFrames).toBe(1);
    expect(hit!.value).toBe('s:4');
  });

  it('peek honors maxDistanceFrames (no wildly-wrong substitute)', async () => {
    const { mgr } = makeMgr();
    mgr.setView('coarse', { sourceKey: 's', level: 2, startFrame: 0, endFrame: 4, pattern: 'window' });
    await flush();
    // Frame 50 is far from any cached tile (0,4) → reject within a tight cap.
    expect(mgr.peek('s', 50, 0, 8)).toBeNull();
  });

  it('shares one entry across levels at coincident frames', async () => {
    const { mgr } = makeMgr();
    await mgr.ensure('s', 8, 0); // fill level-0 frame 8
    await flush();
    const decodes = mgr.stats().decodes;

    // level 3 stride 8 → snapped frame 8 → the SAME entry, already resident.
    expect(mgr.has('s', 8, 3)).toBe(true);
    expect(mgr.peek('s', 8, 3)).toMatchObject({ frame: 8, exact: true });
    await mgr.ensure('s', 8, 3);
    expect(mgr.stats().decodes).toBe(decodes); // no extra decode
  });

  it('deduplicates concurrent ensure() for the same tile', async () => {
    const { mgr, dec } = makeMgr();
    const [a, b] = await Promise.all([mgr.ensure('s', 7, 0), mgr.ensure('s', 7, 0)]);
    expect(a).toBe('s:7');
    expect(b).toBe('s:7');
    expect(dec.count).toBe(1);
  });

  it('keeps a loop region pinned while a competing window churns memory', async () => {
    const { mgr } = makeMgr({ baseCapacity: 4 });
    // Pinned loop of 3 tiles.
    mgr.setView('loop', { sourceKey: 's', level: 0, startFrame: 0, endFrame: 2, pattern: 'loop' });
    await flush();
    // A big window elsewhere — far more tiles than baseCapacity.
    mgr.setView('win', { sourceKey: 's', level: 0, startFrame: 100, endFrame: 130, pattern: 'window' });
    await flush();
    // Drop the window; shrink back. The loop must still be resident (pinned).
    mgr.setView('win', null);
    await flush();
    for (let f = 0; f <= 2; f++) expect(mgr.has('s', f, 0)).toBe(true);
  });
});
