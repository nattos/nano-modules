import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';
import { seedTestPlugins } from "../engine/test-plugins";
seedTestPlugins(); // offline registry: catalogEffect resolves source/effect roles

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

  it('focused effect card: bypass clears its __enable__ (not the clip)', () => {
    store.select(paths.clip(trk, clip));
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/1`); // the saturate device
    store.toggleBypassShortcut();
    const devs = store.trackById(trk)!.clips.find((x) => x.id === clip)!.sketch.devices;
    expect(devs[1].state?.__enable__).toBe(false);
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

/**
 * ⌘J Consolidate / ⇧⌘J Uncollapse gating. The keydown branches themselves live
 * in arrangement-app.onKey; these pin the store predicates behind them (and
 * that ⌘E Split is untouched).
 */
describe('consolidate shortcut gating', () => {
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
  });

  it('canConsolidate follows the time box', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 8);
    store.clearSelection();
    store.clearTimeSelection();
    expect(store.canConsolidate).toBe(false); // no box AND nothing selected
    store.setTimeSelection(0, 8, [t]);
    expect(store.canConsolidate).toBe(true);
    // A selected clip alone is enough (its extent is the fallback range).
    store.clearTimeSelection();
    store.select(paths.clip(t, store.trackById(t)!.clips[0].id));
    expect(store.canConsolidate).toBe(true);
  });

  it('canUncollapse only once a sequence clip exists', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 8);
    store.setTimeSelection(0, 8, [t]);
    expect(store.canUncollapse).toBe(false);
    store.consolidateSelection();
    store.setTimeSelection(0, 8, [t]);
    expect(store.canUncollapse).toBe(true);
  });

  it('⌘E Split still splits (the bindings do not collide)', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 8);
    store.setTimeSelection(4, 4, [t]);
    store.splitAtCursor();
    expect(store.trackById(t)!.clips).toHaveLength(2);
  });
});
