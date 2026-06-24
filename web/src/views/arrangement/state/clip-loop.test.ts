import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';

/**
 * Clip play-mode timing (the read-side play modes): the `updateClipLoop` store
 * action is a single undoable mutation that shallow-merges, and new clips seed the
 * looping `time` default.
 */
describe('clip play-mode timing', () => {
  let trk: string;
  let clip: string;
  beforeEach(() => {
    store.clearSelection();
    trk = store.addTrack();
    clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
  });

  const loopOf = () => store.trackById(trk)!.clips.find((c) => c.id === clip)!.loop;

  it('a new clip defaults to looping `time` at neutral speed', () => {
    const l = loopOf();
    expect(l.mode).toBe('time');
    expect(l.startSec).toBe(0);
    expect(l.speed).toBe(1);
    expect(l.direction).toBe('forward');
  });

  it('updateClipLoop shallow-merges; edits to distinct fields are independent undos', () => {
    store.updateClipLoop(trk, clip, { mode: 'one-shot', startSec: 2 });
    expect(loopOf().mode).toBe('one-shot');
    expect(loopOf().startSec).toBe(2);
    expect(loopOf().speed).toBe(1); // untouched fields preserved (shallow merge)

    // A different field is its own step — it must NOT clobber the earlier patch.
    store.updateClipLoop(trk, clip, { speed: 0.5 });
    expect(loopOf().mode).toBe('one-shot');
    expect(loopOf().speed).toBe(0.5);

    store.undo(); // reverts only the speed edit
    expect(loopOf().speed).toBe(1);
    expect(loopOf().mode).toBe('one-shot');

    store.undo(); // reverts the mode+startSec edit
    expect(loopOf().mode).toBe('time');
    expect(loopOf().startSec).toBe(0);
  });

  it('a slider scrub of ONE field coalesces into a single undo', () => {
    for (const s of [1.1, 1.4, 2.0]) store.updateClipLoop(trk, clip, { speed: s });
    expect(loopOf().speed).toBe(2.0);
    store.undo(); // one step back to the default, not three
    expect(loopOf().speed).toBe(1);
  });
});

/**
 * Phase 2 — editor write-side. A one-shot clip's manual resize couples the slice
 * start (so content stays pinned, capped at the source start) and caps its length at
 * the source end; a BPM change reflows one-shot clip lengths (Ableton warp-off).
 */
describe('one-shot resize coupling', () => {
  let trk: string;
  const clipOf = (id: string) => store.trackById(trk)!.clips.find((c) => c.id === id)!;
  // 300 frames @ 30 fps = 10 s source.
  const addOneShot = (start: number, len: number, startSec = 2): string => {
    const id = store.addVideoClip(trk, start, { sourceKey: `k${start}`, url: `u${start}`, frameCount: 300, fps: 30 }, len)!.split('/')[2];
    store.updateClipLoop(trk, id, { mode: 'one-shot', startSec, speed: 1 });
    return id;
  };
  beforeEach(() => {
    store.clearSelection();
    store.setBpm(120); // spb = 0.5 s/beat
    trk = store.addTrack();
  });

  it('LEFT-edge trim moves startSec so content stays pinned', () => {
    const id = addOneShot(0, 8, 2);
    // Drag the left edge to beat 4 (end held at 8). 4 beats × 0.5 s/beat × speed 1 = +2 s.
    store.resizeClip(trk, id, 4, 4);
    const c = clipOf(id);
    expect(c.startBeat).toBe(4);
    expect(c.lengthBeat).toBe(4);
    expect(c.loop.startSec).toBeCloseTo(4);
  });

  it('LEFT-edge trim caps at the source start (startSec ≥ 0)', () => {
    const id = addOneShot(4, 4, 1); // startSec 1 ⇒ only 2 beats of headroom (1s / 0.5)
    // Ask to drag the left edge all the way to 0 (end held at 8): startSec would go -1.
    store.resizeClip(trk, id, 0, 8);
    const c = clipOf(id);
    expect(c.loop.startSec).toBe(0);
    expect(c.startBeat).toBeCloseTo(2); // edge stops where startSec hits 0
    expect(c.lengthBeat).toBeCloseTo(6); // end (8) − clamped start (2)
  });

  it('RIGHT-edge grow caps the length at the source end', () => {
    const id = addOneShot(0, 8, 2); // startSec 2 ⇒ (10−2)/0.5 = 16 beats max
    store.resizeClip(trk, id, 0, 40); // ask for way too long
    expect(clipOf(id).lengthBeat).toBeCloseTo(16);
  });

  it('a looping (time) clip is NOT coupled — resize only changes length', () => {
    const id = store.addVideoClip(trk, 0, { sourceKey: 'kt', url: 'ut', frameCount: 300, fps: 30 }, 8)!.split('/')[2];
    store.updateClipLoop(trk, id, { mode: 'time', startSec: 2 });
    store.resizeClip(trk, id, 4, 4);
    const c = clipOf(id);
    expect(c.startBeat).toBe(4);
    expect(c.loop.startSec).toBe(2); // untouched
  });
});

describe('BPM reflow (one-shot clip lengths)', () => {
  let trk: string;
  const clipOf = (id: string) => store.trackById(trk)!.clips.find((c) => c.id === id)!;
  beforeEach(() => {
    store.clearSelection();
    store.setBpm(100);
    trk = store.addTrack();
  });

  it('scales a one-shot clip length by the tempo ratio; leaves time/beat-sync', () => {
    const one = store.addVideoClip(trk, 0, { sourceKey: 'k1', url: 'u1', frameCount: 600, fps: 30 }, 8)!.split('/')[2];
    store.updateClipLoop(trk, one, { mode: 'one-shot', startSec: 0 });
    const tim = store.addVideoClip(trk, 40, { sourceKey: 'k2', url: 'u2', frameCount: 600, fps: 30 }, 8)!.split('/')[2];
    store.updateClipLoop(trk, tim, { mode: 'time' });

    store.setBpm(200); // ratio 2
    expect(clipOf(one).lengthBeat).toBeCloseTo(16); // one-shot reflows
    expect(clipOf(tim).lengthBeat).toBe(8); // time clip unchanged
  });

  it('lengthening resolves overlaps by keeping starts and trimming ends', () => {
    const a = store.addVideoClip(trk, 0, { sourceKey: 'ka', url: 'ua', frameCount: 600, fps: 30 }, 8)!.split('/')[2];
    const b = store.addVideoClip(trk, 8, { sourceKey: 'kb', url: 'ub', frameCount: 600, fps: 30 }, 8)!.split('/')[2];
    store.updateClipLoop(trk, a, { mode: 'one-shot', startSec: 0 });
    store.updateClipLoop(trk, b, { mode: 'one-shot', startSec: 0 });

    store.setBpm(200); // both → 16 beats; A [0,16] now overlaps B's start at 8
    expect(clipOf(a).startBeat).toBe(0);
    expect(clipOf(a).lengthBeat).toBeCloseTo(8); // A trimmed back to B's start
    expect(clipOf(b).startBeat).toBe(8); // B's start preserved
    expect(clipOf(b).lengthBeat).toBeCloseTo(16);
  });

  it('reflow undoes in one step', () => {
    const one = store.addVideoClip(trk, 0, { sourceKey: 'ku', url: 'uu', frameCount: 600, fps: 30 }, 8)!.split('/')[2];
    store.updateClipLoop(trk, one, { mode: 'one-shot', startSec: 0 });
    store.setBpm(200);
    expect(clipOf(one).lengthBeat).toBeCloseTo(16);
    store.undo();
    expect(clipOf(one).lengthBeat).toBe(8);
    expect(store.composition.meta.baseBPM).toBe(100);
  });
});
