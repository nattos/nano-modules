import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { store, paths } from './store';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins(); // offline registry: catalogEffect resolves source/effect roles

/**
 * Per-effect-card copy/cut/paste, driven by chainFocusPath (Cmd+C/X/V while an
 * effect card is focused — see arrangement-app.ts's onKey). Independent of the
 * clip/automation clipboards (clip-clipboard.test.ts / auto-clipboard.test.ts),
 * which operate on the timeline surface instead.
 */
describe('effect chain-focus clipboard', () => {
  let trk: string;
  let clip: string;

  beforeEach(() => {
    store.clearSelection();
    store.setChainFocus(null);
    trk = store.addTrack();
    clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'source.solid_color');
    store.addClipDeviceType(trk, clip, 'color.saturate');
  });

  function devices() {
    return store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices;
  }

  it('copyChainFocus fills the clipboard from the focused device', () => {
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/1`); // the saturate device
    devices()[1].state = { ...devices()[1].state, amount: 0.5 };

    expect(store.copyChainFocus()).toBe(true);
  });

  it('copyChainFocus returns false with no chain focus', () => {
    expect(store.hasChainFocus).toBe(false);
    expect(store.copyChainFocus()).toBe(false);
  });

  it('cutChainFocus copies then removes the device as one clean undo point', () => {
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/1`);

    store.cutChainFocus();

    expect(devices().map((d) => d.moduleType)).toEqual(['source.solid_color']);
    expect(store.hasChainFocus).toBe(false);

    // Exactly one undo point restores the cut device (in one step, not folded
    // in with the beforeEach setup's own undoable mutations).
    store.undo();
    expect(devices().map((d) => d.moduleType)).toEqual(['source.solid_color', 'color.saturate']);
  });

  it('pasteAtChainFocus inserts a fresh device right after the focused one', async () => {
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`); // the solid_color device
    store.copyChainFocus();

    await store.pasteAtChainFocus();

    const types = devices().map((d) => d.moduleType);
    expect(types).toEqual(['source.solid_color', 'source.solid_color', 'color.saturate']);
    // A fresh, independent device id — not a reference back to the original.
    expect(devices()[1].id).not.toBe(devices()[0].id);
  });
});

describe('effect clipboard OS interop', () => {
  const realClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true });
  });

  let trk: string;
  let clip: string;
  beforeEach(() => {
    store.clearSelection();
    store.setChainFocus(null);
    trk = store.addTrack();
    clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'source.solid_color');
  });

  function devices() {
    return store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices;
  }

  it('copyChainFocus mirrors the payload to the OS clipboard as JSON', () => {
    let written: string | null = null;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { written = t; return Promise.resolve(); } },
      configurable: true,
    });
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`);

    store.copyChainFocus();

    expect(written).not.toBeNull();
    const parsed = JSON.parse(written!);
    expect(parsed.kind).toBe('effect');
    expect(parsed.moduleType).toBe('source.solid_color');
  });

  it('pasteAtChainFocus prefers a valid effect JSON found on the OS clipboard', async () => {
    const external = { kind: 'effect', moduleType: 'color.saturate', state: {} };
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve(JSON.stringify(external)) },
      configurable: true,
    });
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`);

    await store.pasteAtChainFocus();

    expect(devices().map((d) => d.moduleType)).toEqual(['source.solid_color', 'color.saturate']);
  });

  it('pasteAtChainFocus accepts the IDE\'s multi-card payload, inserting the cards in order', async () => {
    // What the effect IDE writes for ANY card selection (single included) —
    // its wires are keyed by IDE instance keys, so they're dropped here.
    const external = {
      kind: 'effects',
      items: [
        { moduleType: 'color.saturate', state: { amount: 0.5 }, key: 'sat@1' },
        { moduleType: 'source.solid_color', state: {}, key: 'sol@1' },
      ],
      wires: [{
        id: 'w_midi',
        src: { instanceKey: 'midi:devA', field: 'b0/e05/turn' },
        dest: { instanceKey: 'sat@1', field: 'amount' },
      }],
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve(JSON.stringify(external)) },
      configurable: true,
    });
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`);

    await store.pasteAtChainFocus();

    expect(devices().map((d) => d.moduleType))
      .toEqual(['source.solid_color', 'color.saturate', 'source.solid_color']);
    expect(devices()[1].state?.amount).toBe(0.5);
  });

  it('pasteAtChainFocus falls back to the in-app clipboard when the OS clipboard has non-JSON text', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve('not json') },
      configurable: true,
    });
    store.setChainFocus(`effect/clip/${trk}/${clip}/0/0`);
    store.copyChainFocus(); // fills the in-app fallback with source.solid_color

    await store.pasteAtChainFocus();

    expect(devices().map((d) => d.moduleType)).toEqual(['source.solid_color', 'source.solid_color']);
  });
});
