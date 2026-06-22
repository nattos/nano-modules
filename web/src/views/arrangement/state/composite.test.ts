import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';

/**
 * compositeClipsAtBeat — the timeline → composite-layer resolution that drives
 * the multi-track monitor. Covers active-at-beat selection, draw order (downward
 * sum: top track first → bottom track on top), bypass/solo, media exclusion,
 * empties, and overlap tie-break.
 */
describe('compositeClipsAtBeat', () => {
  let topId: string; // first 'track' kind = topmost
  let botId: string;

  const withDevice = (trackId: string, start: number, len = 8): string => {
    const path = store.createEmptyClip(trackId, start, len)!;
    const clipId = path.split('/')[2];
    store.addClipDeviceType(trackId, clipId, 'color.hsl');
    return clipId;
  };

  beforeEach(() => {
    const tracks = store.composition.tracks.filter((t) => t.kind === 'track');
    topId = tracks[0].id;
    botId = tracks[1].id;
    // Clear any solo/bypass left from a prior case.
    for (const t of store.composition.tracks) { t.soloed = false; t.bypassed = false; }
  });

  it('returns active clips in draw order (downward sum: top first → bottom on top)', () => {
    withDevice(topId, 40);
    withDevice(botId, 40);
    const layers = store.compositeClipsAtBeat(42);
    expect(layers.length).toBe(2);
    expect(layers[0].track.id).toBe(topId); // top track painted first (background)
    expect(layers[layers.length - 1].track.id).toBe(botId); // bottom track drawn last (on top)
  });

  it('excludes clips outside the beat', () => {
    withDevice(topId, 40, 8);
    expect(store.compositeClipsAtBeat(100).some((l) => l.track.id === topId)).toBe(false);
  });

  it('bypass drops a track; solo restricts to soloed', () => {
    withDevice(topId, 44);
    withDevice(botId, 44);
    store.toggleBypass(topId);
    expect(store.compositeClipsAtBeat(46).map((l) => l.track.id)).toEqual([botId]);
    store.toggleBypass(topId); // un-bypass

    store.toggleSolo(botId);
    expect(store.compositeClipsAtBeat(46).map((l) => l.track.id)).toEqual([botId]);
  });

  it('excludes media clips and empty (device-less) clips', () => {
    // Empty effect clip (no device) at a clear beat.
    store.createEmptyClip(topId, 70, 6);
    expect(store.compositeClipsAtBeat(72).some((l) => l.track.id === topId)).toBe(false);
    // The fake composition has a media clip ('Intro Plate', 0–16) → excluded.
    expect(store.compositeClipsAtBeat(2).every((l) => !l.clip.source?.url)).toBe(true);
  });

  it('on overlap within a track, the latest-started clip wins', () => {
    withDevice(topId, 80, 10); // [80,90)
    const late = withDevice(topId, 84, 10); // [84,94) — starts later
    const layer = store.compositeClipsAtBeat(86).find((l) => l.track.id === topId);
    expect(layer?.clip.id).toBe(late);
  });
});
