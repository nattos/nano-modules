import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * Clip editing semantics added for hands-on use: clips are mutually exclusive
 * (a moved/resized clip carves the lane), time-box content move, body-vs-header
 * selection, and the paused/playing play-from behaviour.
 */
describe('clip mutual exclusion (carve)', () => {
  let a: string;
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
    a = store.addTrack();
  });

  it('moving a clip over another trims the overlapped section', () => {
    const ca = store.createEmptyClip(a, 0, 8)!.split('/')[2];
    const cb = store.createEmptyClip(a, 12, 8)!.split('/')[2];
    store.moveClip(a, cb, 4); // B → [4,12], overlaps A [0,8]
    const A = store.trackById(a)!.clips.find((c) => c.id === ca)!;
    expect(A.startBeat).toBe(0);
    expect(A.lengthBeat).toBe(4); // trimmed to [0,4]
  });

  it('dropping a clip into the middle of another splits it into two', () => {
    const ca = store.createEmptyClip(a, 0, 16)!.split('/')[2];
    const cb = store.createEmptyClip(a, 20, 4)!.split('/')[2];
    store.moveClip(a, cb, 4); // B → [4,8] inside A [0,16]
    const clips = store.trackById(a)!.clips;
    expect(clips.length).toBe(3); // A-left, B, A-right
    const left = clips.find((c) => c.id === ca)!;
    expect(left.startBeat).toBe(0);
    expect(left.lengthBeat).toBe(4);
    const right = clips.find((c) => c.id !== ca && c.id !== cb && c.startBeat === 8)!;
    expect(right.lengthBeat).toBe(8); // [8,16]
  });
});

describe('time-box content move', () => {
  it('splits at the box edges and shifts the in-box content', () => {
    store.clearSelection();
    const a = store.addTrack();
    store.createEmptyClip(a, 0, 16);
    store.setTimeSelection(4, 12, [a]);
    store.moveTimeBoxContent(8); // [4,12) → [12,20)
    const clips = store.trackById(a)!.clips.slice().sort((x, y) => x.startBeat - y.startBeat);
    expect(clips.map((c) => [c.startBeat, c.lengthBeat])).toEqual([
      [0, 4], // the part before the box stays
      [12, 8], // the box content moved +8 (overwriting [12,16])
    ]);
  });
});

describe('time-box move across tracks + box follows', () => {
  it('moves in-box content to another track and the box follows', () => {
    store.clearSelection();
    store.clearTimeSelection();
    const a = store.addTrack();
    const b = store.addTrack();
    const path = store.createEmptyClip(a, 4, 8)!;
    const clipId = path.split('/')[2];
    store.setTimeSelection(4, 12, [a]);
    // Shift +2 beats and +1 track, passing the gesture base box.
    store.moveTimeBoxContent(2, 1, { start: 4, end: 12, scope: [a] });
    expect(store.trackById(a)!.clips.find((c) => c.id === clipId)).toBeUndefined();
    const moved = store.trackById(b)!.clips.find((c) => c.id === clipId);
    expect(moved).toBeDefined();
    expect(moved!.startBeat).toBe(6);
    // The box selection followed to track b at the shifted time.
    expect(store.timeSelStart).toBe(6);
    expect(store.timeSelEnd).toBe(14);
    expect(store.timeSelTrackIds).toEqual([b]);
  });
});

describe('selection + play-from', () => {
  it('selectClipOnly selects without grabbing a time box', () => {
    store.clearTimeSelection();
    const a = store.addTrack();
    const path = store.createEmptyClip(a, 4, 8)!;
    store.clearTimeSelection();
    store.selectClipOnly(path);
    expect(store.isSelected(path)).toBe(true);
    expect(store.hasTimeSelection).toBe(false);
  });

  it('timeBoxCoversClip reflects overlap + scope', () => {
    const a = store.addTrack();
    const path = store.createEmptyClip(a, 4, 8)!; // [4,12]
    const clipId = path.split('/')[2];
    store.setTimeSelection(0, 6, [a]);
    expect(store.timeBoxCoversClip(a, clipId)).toBe(true);
    store.setTimeSelection(20, 24, [a]);
    expect(store.timeBoxCoversClip(a, clipId)).toBe(false);
  });

  it('play-from follows the cursor when paused, not while playing', () => {
    store.playing = false;
    store.setPlayFrom(10);
    expect(store.playFromBeat).toBe(10);
    expect(store.positionBeat).toBe(10); // paused → playhead follows

    store.playing = true;
    store.positionBeat = 5;
    store.setPlayFrom(20);
    expect(store.playFromBeat).toBe(20);
    expect(store.positionBeat).toBe(5); // playing → playhead keeps running
    store.playing = false;
  });
});
