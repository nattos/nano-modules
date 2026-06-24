import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * The 2D edit caret (text-cursor model): a HEAD time/track + an ANCHOR; the
 * time box + play-from are derived. Zero time-width = a vertical slice spanning
 * the anchor→head track range.
 */
describe('2D caret model', () => {
  let T: string[];
  beforeEach(() => {
    store.clearSelection();
    // Three fresh plain tracks, top→bottom (referenced by id, so accumulation
    // across tests is harmless).
    T = [store.addTrack(), store.addTrack(), store.addTrack()];
  });

  it('zero-width caret = a slice; no time box; play-from at head', () => {
    const [t1] = T;
    store.setCaret({ anchorBeat: 8, anchorTrackId: t1, headBeat: 8, headTrackId: t1 });
    expect(store.hasTimeSelection).toBe(false);
    expect(store.timeSelStart).toBeNull();
    expect(store.playFromBeat).toBe(8);
    expect(store.caretTrackIds).toEqual([t1]);
  });

  it('time-width caret = a box; derived start/end; span anchor→head', () => {
    const [t1, , t3] = T;
    store.setCaret({ anchorBeat: 4, anchorTrackId: t1, headBeat: 16, headTrackId: t3 });
    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelStart).toBe(4);
    expect(store.timeSelEnd).toBe(16);
    expect(store.caretTrackIds).toEqual(T); // t1,t2,t3 contiguous
  });

  it('dragging head backward keeps min/max ordering', () => {
    const [t1] = T;
    store.setCaret({ anchorBeat: 20, anchorTrackId: t1, headBeat: 6, headTrackId: t1 });
    expect(store.timeSelStart).toBe(6);
    expect(store.timeSelEnd).toBe(20);
    expect(store.playFromBeat).toBe(6); // head is where the cursor is
  });

  it('empty anchor+head = a global span (all plain tracks)', () => {
    store.setCaret({ anchorBeat: 0, anchorTrackId: '', headBeat: 32, headTrackId: '' });
    expect(store.caretTrackIds).toEqual([]); // [] = global
    expect(store.hasTimeSelection).toBe(true);
  });

  it('setPlayFrom collapses the box to a caret (keeps head track)', () => {
    const [t1, , t3] = T;
    store.setCaret({ anchorBeat: 4, anchorTrackId: t1, headBeat: 16, headTrackId: t3 });
    expect(store.hasTimeSelection).toBe(true);
    store.setPlayFrom(10);
    expect(store.hasTimeSelection).toBe(false);
    expect(store.playFromBeat).toBe(10);
    expect(store.caretHeadTrackId).toBe(t3); // head track preserved
  });

  it('clipAtBeat finds the clip whose span contains a beat', () => {
    const [t1] = T;
    store.createEmptyClip(t1, 4, 8); // [4,12)
    expect(store.clipAtBeat(t1, 6)?.startBeat).toBe(4);
    expect(store.clipAtBeat(t1, 12)).toBeUndefined(); // end is exclusive
    expect(store.clipAtBeat(t1, 0)).toBeUndefined();
  });

  it('splitAtCursor (slice) splits only the spanned tracks at the head beat', () => {
    const [t1, t2, t3] = T;
    for (const t of [t1, t2, t3]) store.createEmptyClip(t, 0, 16); // [0,16) each
    // Slice spanning t1..t2 at beat 8.
    store.setCaret({ anchorBeat: 8, anchorTrackId: t1, headBeat: 8, headTrackId: t2 });
    store.splitAtCursor();
    expect(store.trackById(t1)!.clips.length).toBe(2); // split
    expect(store.trackById(t2)!.clips.length).toBe(2); // split
    expect(store.trackById(t3)!.clips.length).toBe(1); // untouched
  });

  it('selectClipsInCaret (slice) selects clips containing the head beat on the span', () => {
    const [t1, t2, t3] = T;
    for (const t of [t1, t2, t3]) store.createEmptyClip(t, 0, 16);
    store.setCaret({ anchorBeat: 8, anchorTrackId: t1, headBeat: 8, headTrackId: t2 });
    store.selectClipsInCaret();
    const sel = [...store.selection];
    expect(sel.some((p) => p.startsWith(`clip/${t1}/`))).toBe(true);
    expect(sel.some((p) => p.startsWith(`clip/${t2}/`))).toBe(true);
    expect(sel.some((p) => p.startsWith(`clip/${t3}/`))).toBe(false);
  });
});

describe('caret lane rows (automation lanes as navigable rows)', () => {
  let t1: string;
  let laneId: string;
  beforeEach(() => {
    store.clearSelection();
    if (!store.automationMode) store.toggleAutomationMode();
    t1 = store.addTrack();
    laneId = store.ensureTrackAutomationLane(t1);
  });

  it('caretRows lists the track clip row + each automation lane row', () => {
    const rows = store.caretRows.filter((r) => r.trackId === t1);
    expect(rows).toEqual([{ trackId: t1, laneId: '' }, { trackId: t1, laneId }]);
  });

  it('arrow-down from the track steps onto ITS lane (not the next track)', () => {
    store.setCaret({ anchorBeat: 4, anchorTrackId: t1, headBeat: 4, headTrackId: t1 }); // clip row
    expect(store.caretLaneId).toBeNull();
    store.caretMoveVertical(1);
    expect(store.caretHeadTrackId).toBe(t1);
    expect(store.caretHeadLaneId).toBe(laneId);
    expect(store.caretLaneId).toBe(laneId);
  });

  it('a lane caret selects no clips + reports no clip-track span', () => {
    store.createEmptyClip(t1, 0, 8);
    store.setCaret({ anchorBeat: 4, anchorTrackId: t1, anchorLaneId: laneId, headBeat: 4, headTrackId: t1, headLaneId: laneId });
    store.selectClipsInCaret();
    expect(store.selection.size).toBe(0);
    expect(store.caretTrackIds).toEqual([]); // no clip rows in the span
    expect(store.caretLaneIds).toEqual([laneId]);
  });
});

describe('caret keyboard navigation', () => {
  let T: string[];
  beforeEach(() => {
    store.clearSelection();
    store.setZoom(22); // snapStep = 1 beat (deterministic)
    T = [store.addTrack(), store.addTrack()];
  });

  it('Left/Right step one grid unit, collapse, and select under the head', () => {
    const [t1] = T;
    store.setCaret({ anchorBeat: 5, anchorTrackId: t1, headBeat: 5, headTrackId: t1 });
    store.caretMoveHorizontal(1);
    expect(store.playFromBeat).toBe(6);
    expect(store.hasTimeSelection).toBe(false);
    expect(store.primaryPath).toBe(`track/${t1}`); // empty → track under head
    store.caretMoveHorizontal(-1);
    expect(store.playFromBeat).toBe(5);
  });

  it('Shift+Right extends (keeps the anchor → a box)', () => {
    const [t1] = T;
    store.setCaret({ anchorBeat: 5, anchorTrackId: t1, headBeat: 5, headTrackId: t1 });
    store.caretMoveHorizontal(1, { extend: true });
    expect(store.timeSelStart).toBe(5);
    expect(store.timeSelEnd).toBe(6);
    expect(store.hasTimeSelection).toBe(true);
  });

  it('Option+Right jumps to the next clip edge across the caret tracks', () => {
    const [t1] = T;
    store.createEmptyClip(t1, 4, 8); // edges at 4 and 12
    store.setCaret({ anchorBeat: 5, anchorTrackId: t1, headBeat: 5, headTrackId: t1 });
    store.caretMoveHorizontal(1, { toEvent: true });
    expect(store.playFromBeat).toBe(12); // next edge after 5
    store.caretMoveHorizontal(-1, { toEvent: true });
    expect(store.playFromBeat).toBe(4); // prev edge before 12
  });

  it('Up/Down move the head track; Shift grows the vertical slice', () => {
    const [t1, t2] = T;
    store.setCaret({ anchorBeat: 8, anchorTrackId: t1, headBeat: 8, headTrackId: t1 });
    store.caretMoveVertical(1);
    expect(store.caretHeadTrackId).toBe(t2);
    expect(store.caretTrackIds).toEqual([t2]); // collapsed
    store.caretMoveVertical(-1, true); // extend back up
    expect(store.caretTrackIds).toEqual([t1, t2]); // slice spans both
  });
});
