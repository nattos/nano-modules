import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * Shift-click = RANGE extend. A shift-click on a clip header must box the whole
 * region between the anchor clip and the clicked one, select every clip inside
 * it, and leave the play-from marker on the box's START — that's what makes the
 * follow-up header drag move the entire range (the time-box move path) and
 * Space play the content instead of the silence after it.
 */
describe('shift-click clip range selection', () => {
  let T: string[];
  beforeEach(() => {
    store.clearSelection();
    T = [store.addTrack(), store.addTrack(), store.addTrack()];
  });

  it('boxes the union span, selects the clips in between, and cues the start', () => {
    const [t1, t2, t3] = T;
    const a = store.createEmptyClip(t1, 0, 4)!;   // [0,4)
    const mid = store.createEmptyClip(t2, 6, 4)!; // [6,10) — inside the range
    const b = store.createEmptyClip(t3, 12, 4)!;  // [12,16)
    const far = store.createEmptyClip(t3, 40, 4)!; // outside

    store.select(a);
    store.extendClipSelectionTo(b);

    expect(store.timeSelStart).toBe(0);
    expect(store.timeSelEnd).toBe(16);
    expect(store.timeSelTrackIds).toEqual([t1, t2, t3]);
    // Every clip the box touches is selected — including the untouched middle track.
    expect(store.isSelected(a)).toBe(true);
    expect(store.isSelected(mid)).toBe(true);
    expect(store.isSelected(b)).toBe(true);
    expect(store.isSelected(far)).toBe(false);
    // The clicked clip stays the inspector focus.
    expect(store.primaryPath).toBe(b);
    // Play-from sits at the START of the range, not its end.
    expect(store.playFromBeat).toBe(0);
  });

  it('extends upward/leftward just the same', () => {
    const [t1, , t3] = T;
    const a = store.createEmptyClip(t1, 8, 4)!;
    const b = store.createEmptyClip(t3, 0, 2)!;
    store.select(a);
    store.extendClipSelectionTo(b);
    expect(store.timeSelStart).toBe(0);
    expect(store.timeSelEnd).toBe(12);
    expect(store.playFromBeat).toBe(0);
  });

  it('the boxed range drags as ONE unit (timeBoxCoversClip on every member)', () => {
    const [t1, , t3] = T;
    const a = store.createEmptyClip(t1, 0, 4)!;
    const b = store.createEmptyClip(t3, 8, 4)!;
    store.select(a);
    store.extendClipSelectionTo(b);
    expect(store.timeBoxCoversClip(t1, a.split('/')[2])).toBe(true);
    expect(store.timeBoxCoversClip(t3, b.split('/')[2])).toBe(true);

    const base = { start: store.timeSelStart!, end: store.timeSelEnd, scope: [...store.timeSelTrackIds] };
    store.moveTimeBoxContent(4, 0, base);
    expect(store.trackById(t1)!.clips[0].startBeat).toBe(4);
    expect(store.trackById(t3)!.clips[0].startBeat).toBe(12);
    // The box follows, still start-anchored.
    expect(store.timeSelStart).toBe(4);
    expect(store.playFromBeat).toBe(4);
  });

  it('falls back to a plain select with no clip anchor', () => {
    const [t1] = T;
    const a = store.createEmptyClip(t1, 4, 8)!;
    store.clearSelection();
    store.extendClipSelectionTo(a);
    expect(store.isSelected(a)).toBe(true);
    expect(store.timeSelStart).toBe(4);
    expect(store.timeSelEnd).toBe(12);
  });
});

describe('shift-click track range selection', () => {
  it('selects the contiguous run of tracks and boxes all their time', () => {
    store.clearSelection();
    const T = [store.addTrack(), store.addTrack(), store.addTrack()];
    store.setPlayFrom(9);
    store.select(paths.track(T[0]));
    store.extendTrackSelectionTo(T[2]);
    expect(new Set(store.selectedTrackIds)).toEqual(new Set(T));
    expect(store.timeSelStart).toBe(0);
    expect(store.timeSelTrackIds).toEqual(T);
    // Widening the scope must not yank the transport (same rule as a single select).
    expect(store.playFromBeat).toBe(9);
  });
});

describe('play-from rides the time box START', () => {
  it('a rightward time drag leaves play-from at the left edge', () => {
    store.clearSelection();
    const t = store.addTrack();
    store.setTimeSelection(4, 20, [t]);
    expect(store.timeSelStart).toBe(4);
    expect(store.timeSelEnd).toBe(20);
    expect(store.playFromBeat).toBe(4);
  });

  it('and so does a leftward one', () => {
    store.clearSelection();
    const t = store.addTrack();
    store.setTimeSelection(20, 4, [t]);
    expect(store.timeSelStart).toBe(4);
    expect(store.playFromBeat).toBe(4);
  });
});
