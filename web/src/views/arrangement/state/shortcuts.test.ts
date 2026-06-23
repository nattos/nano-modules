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

  it('selected track: "0" toggles the track bypass (never the main bus)', () => {
    store.clearSelection();
    store.setChainFocus(null);
    const t = store.addTrack();
    store.select(paths.track(t));
    store.toggleBypassShortcut();
    expect(store.trackById(t)!.bypassed).toBe(true);
    // The main bus is immune.
    const bus = store.mainBusTrack!;
    store.select(paths.track(bus.id));
    const was = !!bus.bypassed;
    store.toggleBypassShortcut();
    expect(!!store.trackById(bus.id)!.bypassed).toBe(was);
  });
});

describe('main bus + return tracks', () => {
  it('a main bus always exists and is not deletable', () => {
    const bus = store.mainBusTrack;
    expect(bus).toBeDefined();
    store.select(paths.track(bus!.id));
    store.deleteSelectedTracks();
    expect(store.trackById(bus!.id)).toBeDefined(); // survived
  });

  it('addReturn inserts a rail channel before the main bus', () => {
    const id = store.addReturn();
    const t = store.trackById(id)!;
    expect(t.kind).toBe('rail');
    expect(t.railId).toBeTruthy();
    const idx = store.composition.tracks.findIndex((x) => x.id === id);
    const busIdx = store.composition.tracks.findIndex((x) => store.isMainBus(x));
    expect(busIdx).toBeGreaterThan(idx);
  });
});
