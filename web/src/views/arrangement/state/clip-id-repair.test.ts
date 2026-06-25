import { describe, it, expect, vi, beforeEach } from 'vitest';

// relinkMedia runs on open; stub the media store so it's a no-op here.
vi.mock('../workspace/media-store', () => ({
  openMedia: vi.fn().mockResolvedValue(null),
  resolveMedia: vi.fn().mockResolvedValue(null),
}));

import { store } from './store';
import type { Composition } from '../model/composition';

/**
 * Duplicate clip/device ids make two clips share a composite instance key + a single
 * decode pump → the second clip plays the first's video. Legacy files (saved with the
 * old per-session counter ids, which could collide across reloads) must heal on load;
 * and new ids are UUIDs, so a freshly-created clip can never reuse a loaded id.
 */
const videoClip = (id: string, devId: string, startBeat: number) => ({
  id,
  name: id,
  startBeat,
  lengthBeat: 8,
  kind: 'video' as const,
  sketch: { devices: [{ id: devId, moduleType: 'source.video.file', name: 'v', capabilities: ['source'] }] },
  source: { label: 'v', durationFrames: 300, sourceKey: `k_${id}`, url: `blob:${id}`, fps: 30 },
  loop: { mode: 'time' as const, startSec: 0, speed: 1, direction: 'forward' as const },
  automation: [],
  exports: [],
  warps: [],
});

const dupComposition = (): Composition => ({
  meta: { resolution: { width: 1920, height: 1080 }, baseBPM: 120, timeSignature: [4, 4] },
  tracks: [
    {
      id: 'trk_z', name: 'Footage', kind: 'track', parentId: null,
      sketch: { devices: [] }, automation: [],
      // Both clips minted `clip_rs` / `dev_rt` (the post-reload collision).
      clips: [videoClip('clip_rs', 'dev_rt', 0), videoClip('clip_rs', 'dev_rt', 16)],
    } as never,
  ],
  rails: [],
  playMode: { defaultMode: 'time' },
});

describe('duplicate clip-id repair on load', () => {
  beforeEach(() => {
    (globalThis as unknown as { URL: { createObjectURL: () => string } }).URL.createObjectURL = () => 'blob:x';
  });

  it('heals duplicate clip + device ids so each video gets its own instance key', async () => {
    const backend = { read: async () => dupComposition() } as never;
    await store.openArrangement(backend, 'dup');

    const clips = store.composition.tracks.find((t) => t.id === 'trk_z')!.clips;
    expect(clips.length).toBe(2);
    // Clip ids are now distinct ...
    expect(clips[0].id).not.toBe(clips[1].id);
    // ... and so are the device ids (the duplicate was freshened wholesale).
    const dev = (c: typeof clips[0]) => c.sketch.devices[0].id;
    expect(dev(clips[0])).not.toBe(dev(clips[1]));
    // The composite instance key is clip_<clipId>_<deviceId> — now unique per clip.
    expect(`${clips[0].id}_${dev(clips[0])}`).not.toBe(`${clips[1].id}_${dev(clips[1])}`);
  });

  it('advances the id counter so a NEW clip cannot reuse a loaded id', async () => {
    const backend = { read: async () => dupComposition() } as never;
    await store.openArrangement(backend, 'dup');

    const trk = store.composition.tracks.find((t) => t.id === 'trk_z')!.id;
    const loadedIds = new Set(store.composition.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    const newPath = store.createEmptyClip(trk, 40, 8)!;
    const newId = newPath.split('/')[2];
    expect(loadedIds.has(newId)).toBe(false); // no collision with the loaded ids
    expect(newId).not.toBe('clip_rs');
  });
});
