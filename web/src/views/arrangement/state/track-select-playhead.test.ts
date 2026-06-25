import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * Selecting a TRACK sets a full-track time box but must NOT move the play-from
 * marker / playhead (only clip selection + ruler scrubs do that).
 */
describe('selecting a track leaves the playhead put', () => {
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
  });

  it('sets a track-scoped time box without moving positionBeat/playFromBeat', () => {
    const a = store.addTrack();
    store.setPlayFrom(0); // park the playhead at 0
    store.clearSelection();
    store.clearTimeSelection();
    const pos = store.positionBeat;
    const pf = store.playFromBeat;

    store.select(paths.track(a));

    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelTrackIds).toEqual([a]);
    expect(store.isTrackShownSelected(a)).toBe(true);
    // The playhead / play-from marker are untouched.
    expect(store.positionBeat).toBe(pos);
    expect(store.playFromBeat).toBe(pf);
  });

  it('keeps a NON-zero playhead exactly where it was', () => {
    const a = store.addTrack();
    store.setPlayFrom(7); // pf = pos = 7 (paused)
    store.select(paths.track(a));
    expect(store.playFromBeat).toBe(7);
    expect(store.positionBeat).toBe(7);
    expect(store.timeSelTrackIds).toEqual([a]);
  });

  it('clip selection still DOES move the playhead (default behaviour)', () => {
    const a = store.addTrack();
    store.setPlayFrom(0);
    const clipPath = store.createEmptyClip(a, 12, 4)!; // [12,16)
    store.select(clipPath);
    // Clip selection syncs the box to the clip extent and moves play-from.
    expect(store.playFromBeat).toBe(16);
    expect(store.positionBeat).toBe(16);
  });
});
