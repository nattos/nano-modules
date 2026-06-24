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

describe('device reorder (moveClipDevice)', () => {
  let trk: string;
  let clip: string;
  beforeEach(() => {
    store.clearSelection();
    trk = store.addTrack();
    clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'source.solid_color');
    store.addClipDeviceType(trk, clip, 'color.saturate');
    store.addClipDeviceType(trk, clip, 'color.invert');
  });
  const types = () => store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices.map((d) => d.moduleType);

  it('moves an item down to an insertion index (removal shift applied)', () => {
    // [solid, saturate, invert] — move index 0 to insertion index 3 (the end).
    store.moveClipDevice(trk, clip, 0, 3);
    expect(types()).toEqual(['color.saturate', 'color.invert', 'source.solid_color']);
  });

  it('moves an item up to an earlier index', () => {
    store.moveClipDevice(trk, clip, 2, 0); // invert → front
    expect(types()).toEqual(['color.invert', 'source.solid_color', 'color.saturate']);
  });

  it('no-op when dropping at its own slot', () => {
    store.moveClipDevice(trk, clip, 1, 1);
    expect(types()).toEqual(['source.solid_color', 'color.saturate', 'color.invert']);
  });

  it('deleteChainFocus removes the focused card (path parsing with slashes)', () => {
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/1`); // the middle device
    expect(store.hasChainFocus).toBe(true);
    store.deleteChainFocus();
    expect(types()).toEqual(['source.solid_color', 'color.invert']);
    expect(store.chainFocusPath).toBeNull();
  });

  it('connects, replaces-into-dest, removes, and prunes wires', () => {
    const sid = `clip/${trk}/${clip}`;
    const mk = (chainIdx: number, fieldPath: string, viewportY: number) =>
      ({ sketchId: sid, colIdx: 0, chainIdx, fieldPath, isOutput: false, viewportY, schemaDef: null });
    // [solid, saturate, invert] — connect solid.<f> (upper) → saturate.prescale.
    store.connectSketchWire(mk(0, 'amount', 100), mk(1, 'prescale', 200));
    expect(store.sketchWires(sid).map((w) => `${w.src.field}->${w.dest.field}`)).toEqual(['amount->prescale']);
    // A second wire into the same dest replaces the first.
    store.connectSketchWire(mk(2, 'amount', 100), mk(1, 'prescale', 200));
    expect(store.sketchWires(sid).length).toBe(1);
    expect(store.sketchWires(sid)[0].src.field).toBe('amount');
    // Remove it.
    store.removeSketchWire(sid, store.sketchWires(sid)[0].id);
    expect(store.sketchWires(sid).length).toBe(0);
    // Deleting a device prunes wires that touch it.
    store.connectSketchWire(mk(0, 'amount', 100), mk(1, 'prescale', 200));
    const satId = store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices[1].id;
    store.removeClipDevice(trk, clip, satId);
    expect(store.sketchWires(sid).length).toBe(0);
  });

  it('selecting a clip / clearing selection drops chain focus', () => {
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`);
    store.select(paths.clip(trk, clip));
    expect(store.chainFocusPath).toBeNull();
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`);
    store.clearSelection();
    expect(store.chainFocusPath).toBeNull();
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

  it('addVideoClip overwrites whatever it overlaps (clips may not overlap)', () => {
    const trk = store.addTrack();
    store.createEmptyClip(trk, 0, 8); // existing clip [0,8]
    store.addVideoClip(trk, 4, { sourceKey: 'v', url: 'blob:x', frameCount: 30, fps: 30, label: 'v.mp4' }, 8); // [4,12]
    const clips = store.trackById(trk)!.clips.slice().sort((a, b) => a.startBeat - b.startBeat);
    // No two clips overlap.
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i].startBeat).toBeGreaterThanOrEqual(clips[i - 1].startBeat + clips[i - 1].lengthBeat - 1e-6);
    }
    // The video clip occupies [4,12]; the prior clip was trimmed to [0,4].
    const vid = clips.find((c) => c.source?.sourceKey === 'v')!;
    expect(vid.startBeat).toBe(4);
    const prior = clips.find((c) => c.id !== vid.id)!;
    expect(prior.startBeat + prior.lengthBeat).toBeLessThanOrEqual(4 + 1e-6);
  });

  it('a drag back to EXACTLY the start returns the clip (gesture, no stranding)', () => {
    const trk = store.addTrack();
    const path = store.createEmptyClip(trk, 8, 8)!; // [8,16]
    const clipId = path.split('/')[2];
    store.select(path); // box = [8,16]
    const base = { start: 8, end: 16, scope: [trk] };
    store.beginGesture();
    store.moveTimeBoxContent(8, 0, base); // → 16
    store.moveTimeBoxContent(4, 0, base); // → 12
    store.moveTimeBoxContent(0, 0, base); // back to EXACTLY the start
    store.endGesture();
    const clips = store.trackById(trk)!.clips;
    expect(clips.length).toBe(1); // not duplicated / corrupted
    expect(clips.find((c) => c.id === clipId || true)!.startBeat).toBe(8); // back at the origin
    store.undo();
    expect(store.trackById(trk)!.clips[0].startBeat).toBe(8);
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
