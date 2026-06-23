import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * Keyboard-shortcut store primitives: loop ⇄ time-box, clip/effect bypass.
 */
describe('loop toggle vs time-box', () => {
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
    store.loopEnabled = true;
    store.loopStartBeat = 0;
    store.loopEndBeat = 32;
  });

  it('snaps the loop to the time box (and enables) when the box differs', () => {
    store.setTimeSelection(4, 12, []);
    store.toggleLoopOrSetToTimeBox();
    expect(store.loopEnabled).toBe(true);
    expect(store.loopStartBeat).toBe(4);
    expect(store.loopEndBeat).toBe(12);
  });

  it('toggles off when the box already matches the loop range', () => {
    store.setTimeSelection(0, 32, []);
    store.toggleLoopOrSetToTimeBox(); // same range → toggle
    expect(store.loopEnabled).toBe(false);
  });

  it('plain toggle when no time box', () => {
    store.toggleLoopOrSetToTimeBox();
    expect(store.loopEnabled).toBe(false);
    store.toggleLoopOrSetToTimeBox();
    expect(store.loopEnabled).toBe(true);
  });
});

describe('bypass shortcut', () => {
  let trk: string;
  let clip: string;
  beforeEach(() => {
    store.clearSelection();
    trk = store.addTrack();
    clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'source.solid_color');
    store.addClipDeviceType(trk, clip, 'color.saturate');
  });

  it('selected clips: bypass removes them from the composite', () => {
    store.select(paths.clip(trk, clip));
    expect(store.compositeLayersAtBeat(2).some((l) => l.clip.id === clip)).toBe(true);
    store.toggleBypassShortcut(); // clip selected, no effect focus → clip bypass
    const c = store.trackById(trk)!.clips.find((x) => x.id === clip)!;
    expect(c.bypassed).toBe(true);
    expect(store.compositeLayersAtBeat(2).some((l) => l.clip.id === clip)).toBe(false);
  });

  it('focused effect card: bypass toggles its __bypass__ (not the clip)', () => {
    store.select(paths.clip(trk, clip));
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/1`); // the saturate device
    store.toggleBypassShortcut();
    const devs = store.trackById(trk)!.clips.find((x) => x.id === clip)!.sketch.devices;
    expect(devs[1].state?.__bypass__).toBe(true);
    expect(store.trackById(trk)!.clips.find((x) => x.id === clip)!.bypassed).toBeFalsy();
  });
});
