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
