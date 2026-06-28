import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * Selecting a TRACK selects ALL its time WITHOUT disturbing the transport: neither
 * the play-from marker (`playFromBeat`) nor the visible playhead (`positionBeat`)
 * move — the full-time box is an explicit span that doesn't ride the caret. Only a
 * grid click / clip selection / ruler scrub moves the play-from caret.
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

  it('keeps a NON-zero play-from marker AND playhead put (box spans all time anyway)', () => {
    const a = store.addTrack();
    store.setPlayFrom(7); // pf = pos = 7 (paused)
    store.select(paths.track(a));
    expect(store.positionBeat).toBe(7); // playhead stays where it was
    expect(store.playFromBeat).toBe(7); // play-from marker stays put (NOT yanked to 0)
    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelStart).toBe(0); // ...the box still spans all time
    expect(store.timeSelEnd).toBeGreaterThan(0);
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

describe('slideCaret (clip-drag follow)', () => {
  it('shifts caret + paused playhead by the delta from base, keeping relative offset', () => {
    store.setPlayFrom(4); // anchor = head = pos = 4 (paused)
    const base = {
      anchorBeat: store.caretAnchorBeat,
      headBeat: store.playFromBeat,
      posBeat: store.positionBeat,
    };
    store.slideCaret(base, 3);
    expect(store.caretAnchorBeat).toBe(7);
    expect(store.playFromBeat).toBe(7);
    expect(store.positionBeat).toBe(7); // playhead follows when paused
  });

  it('clamps at 0 (a leftward over-drag parks at the start)', () => {
    store.setPlayFrom(2);
    store.slideCaret({ anchorBeat: 2, headBeat: 2, posBeat: 2 }, -10);
    expect(store.positionBeat).toBe(0);
    expect(store.playFromBeat).toBe(0);
  });
});
