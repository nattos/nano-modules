import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';

/** Clip clipboard + time ops (Cmd+C/X/V, Cmd+Shift+V/X, insert/delete time). */
describe('clip clipboard + time ops', () => {
  let T: string[];
  beforeEach(() => {
    store.clearSelection();
    T = [store.addTrack(), store.addTrack(), store.addTrack()];
  });

  it('copy a time-box SLICE, then paste it at the caret', () => {
    const [t1, t2] = T;
    store.createEmptyClip(t1, 0, 16); // [0,16)
    store.setTimeSelection(4, 12, [t1]); // box of length 8 over the clip
    expect(store.copyClips()).toBe(true);
    // Move the caret to t2 @ beat 20 and paste.
    store.setCaret({ anchorBeat: 20, anchorTrackId: t2, headBeat: 20, headTrackId: t2 });
    store.pasteClips();
    const pasted = store.trackById(t2)!.clips;
    expect(pasted.length).toBe(1);
    expect(pasted[0].startBeat).toBe(20);
    expect(pasted[0].lengthBeat).toBe(8); // the trimmed slice
  });

  it('copy whole selected clips (no box) and paste', () => {
    const [t1, t2] = T;
    const path = store.createEmptyClip(t1, 4, 6)!; // [4,10)
    store.setCaret({ anchorBeat: 4, anchorTrackId: t1, headBeat: 4, headTrackId: t1 });
    store.setSelection([path]);
    expect(store.copyClips()).toBe(true);
    store.setCaret({ anchorBeat: 0, anchorTrackId: t2, headBeat: 0, headTrackId: t2 });
    store.pasteClips();
    const c = store.trackById(t2)!.clips;
    expect(c.length).toBe(1);
    expect(c[0].startBeat).toBe(0); // origin-relative paste
    expect(c[0].lengthBeat).toBe(6);
  });

  it('cutClips on a time box leaves empty time (slice removed)', () => {
    const [t1] = T;
    store.createEmptyClip(t1, 0, 16);
    store.setTimeSelection(4, 12, [t1]);
    store.cutClips();
    // The [4,12) center is gone; left/right pieces remain.
    const clips = store.trackById(t1)!.clips.sort((a, b) => a.startBeat - b.startBeat);
    expect(clips.length).toBe(2);
    expect(clips[0].lengthBeat).toBeCloseTo(4); // [0,4)
    expect(clips[1].startBeat).toBeCloseTo(12); // [12,16)
  });

  it('pasteTime inserts clipboard-length time then pastes (ripple)', () => {
    const [t1] = T;
    store.createEmptyClip(t1, 0, 8); // [0,8)
    store.setTimeSelection(0, 8, [t1]);
    store.copyClips(); // span 8
    const later = store.createEmptyClip(t1, 20, 4)!; // [20,24) downstream
    const laterId = later.split('/')[2];
    // Caret at beat 8: paste-time inserts 8 blank beats then pastes.
    store.setCaret({ anchorBeat: 8, anchorTrackId: t1, headBeat: 8, headTrackId: t1 });
    store.pasteTime();
    const downstream = store.trackById(t1)!.clips.find((c) => c.id === laterId)!;
    expect(downstream.startBeat).toBe(28); // 20 rippled by +8
    expect(store.trackById(t1)!.clips.some((c) => Math.abs(c.startBeat - 8) < 1e-6)).toBe(true);
  });

  it('insertTimeSpan ripples every plain track right', () => {
    const [t1, t2] = T;
    store.createEmptyClip(t1, 10, 4);
    store.createEmptyClip(t2, 10, 4);
    store.insertTimeSpan(0, 5);
    expect(store.trackById(t1)!.clips[0].startBeat).toBe(15);
    expect(store.trackById(t2)!.clips[0].startBeat).toBe(15);
  });

  it('soloShortcut solos the caret head track', () => {
    const [t1] = T;
    store.setCaret({ anchorBeat: 0, anchorTrackId: t1, headBeat: 0, headTrackId: t1 });
    store.clearSelection();
    expect(store.trackById(t1)!.soloed ?? false).toBe(false);
    store.soloShortcut();
    expect(store.trackById(t1)!.soloed).toBe(true);
  });
});
