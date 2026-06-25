import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * Selecting a TRACK selects ALL its time and moves the caret to the beginning of
 * time (play-from → 0), but must NOT move the visible playhead (`positionBeat`).
 * Only clip selection + ruler scrubs move the playhead.
 */
describe('selecting a track selects all time without moving the playhead', () => {
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
  });

  it('sets a full-track time box; caret to 0; positionBeat untouched', () => {
    const a = store.addTrack();
    store.setPlayFrom(0); // park the playhead at 0
    store.clearSelection();
    store.clearTimeSelection();

    store.select(paths.track(a));

    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelTrackIds).toEqual([a]);
    expect(store.isTrackShownSelected(a)).toBe(true);
    expect(store.positionBeat).toBe(0); // visible playhead unchanged
  });

  it('keeps a NON-zero playhead put while caret jumps to the beginning of time', () => {
    const a = store.addTrack();
    store.setPlayFrom(7); // pf = pos = 7 (paused)
    store.select(paths.track(a));
    expect(store.positionBeat).toBe(7); // playhead stays where it was
    expect(store.playFromBeat).toBe(0); // caret/play-from jumped to the start
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
