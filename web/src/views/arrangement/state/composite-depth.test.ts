import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { Track } from '../model/composition';

/**
 * Compositor DEPTH: compositeLayersAtBeat resolves media-vs-engine layer kind,
 * per-track opacity, and group-hierarchy propagation of bypass / solo / opacity
 * (the holes the first compositing slice deferred).
 */
describe('compositeLayersAtBeat depth', () => {
  let group: Track;
  let tA: Track; // will be nested under the group
  let tB: Track; // independent sibling

  const engineClip = (trackId: string, start: number, len = 8) => {
    const path = store.createEmptyClip(trackId, start, len)!;
    const clipId = path.split('/')[2];
    store.addClipDeviceType(trackId, clipId, 'color.hsl');
    return clipId;
  };

  beforeEach(() => {
    // Reset hierarchy/flags so cases don't bleed.
    for (const t of store.composition.tracks) {
      t.soloed = false; t.bypassed = false; t.level = undefined; t.parentId = null;
    }
    group = store.composition.tracks.find((t) => t.kind === 'group')!;
    const tracks = store.composition.tracks.filter((t) => t.kind === 'track');
    tA = tracks[0];
    tB = tracks[1];
  });

  it('classifies media clips as kind=media (and engine-only view drops them)', () => {
    const path = store.createEmptyClip(tA.id, 50, 8)!;
    const clipId = path.split('/')[2];
    const clip = store.clipByPath(path)!.clip;
    clip.source = { label: 'v', durationFrames: 100, sourceKey: 'k', url: 'blob:x' };

    const layers = store.compositeLayersAtBeat(52);
    const media = layers.find((l) => l.clip.id === clipId);
    expect(media?.kind).toBe('media');
    // Engine-only view (the bridge's) excludes media layers.
    expect(store.compositeClipsAtBeat(52).some((l) => l.clip.id === clipId)).toBe(false);
    expect(store.topMediaClipAtBeat(52)?.id).toBe(clipId);
  });

  it('carries per-track opacity from level', () => {
    engineClip(tA.id, 50);
    tA.level = 0.5;
    const layer = store.compositeLayersAtBeat(52).find((l) => l.track.id === tA.id);
    expect(layer?.opacity).toBeCloseTo(0.5, 6);
  });

  it("multiplies a child's opacity by its ancestor group's level", () => {
    engineClip(tA.id, 50);
    tA.parentId = group.id;
    group.level = 0.5;
    tA.level = 0.5;
    const layer = store.compositeLayersAtBeat(52).find((l) => l.track.id === tA.id);
    expect(layer?.opacity).toBeCloseTo(0.25, 6); // 0.5 × 0.5
  });

  it('a bypassed group excludes its child tracks', () => {
    engineClip(tA.id, 50);
    engineClip(tB.id, 50);
    tA.parentId = group.id;
    group.bypassed = true;
    const ids = store.compositeLayersAtBeat(52).map((l) => l.track.id);
    expect(ids).toContain(tB.id);
    expect(ids).not.toContain(tA.id); // child of bypassed group
  });

  it('soloing a group auditions its lineage only', () => {
    engineClip(tA.id, 50);
    engineClip(tB.id, 50);
    tA.parentId = group.id;
    group.soloed = true;
    const ids = store.compositeLayersAtBeat(52).map((l) => l.track.id);
    expect(ids).toContain(tA.id); // under the soloed group
    expect(ids).not.toContain(tB.id); // not in a soloed lineage
  });
});
