import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { store } from '../state/store';
import { clipTarget } from './arr-column-adapter';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * staticHiddenFor must resolve PER-CARD: two same-type effects in one chain each
 * feed their OWN device state to the visibility evaluator. Before the instanceKey
 * was threaded through getPlugin → staticHiddenFor, both shared the FIRST device's
 * resolved hidden set.
 */
describe('clipTarget.staticHiddenFor — per-instance resolution', () => {
  let trackId: string;
  let clipId: string;
  let dev0: string;
  let dev1: string;
  const savedResolver = store.visibilityResolver;

  beforeEach(() => {
    store.fieldVisCache.clear();
    store.fieldVisUnsupported.clear();
    const track = store.composition.tracks.find((t) => t.kind === 'track')!;
    trackId = track.id;
    const path = store.createEmptyClip(trackId, 0, 8);
    clipId = path.split('/')[2];
    // Two effects of the SAME module type, distinguished by hue_shift state.
    store.addClipDeviceType(trackId, clipId, 'color.hsl');
    store.addClipDeviceType(trackId, clipId, 'color.hsl');
    const devices = store.clipByPath(path)!.clip.sketch.devices;
    dev0 = devices[0].id;
    dev1 = devices[1].id;
    store.setClipDeviceField(trackId, clipId, dev1, 'hue_shift', 0.5);
    // Stub the evaluator: the hidden set depends on the device's own state.
    store.visibilityResolver = async (_mt, state) =>
      (state as { hue_shift?: number }).hue_shift ? ['lightness'] : ['saturation'];
  });

  afterEach(() => {
    store.visibilityResolver = savedResolver;
  });

  it('each same-type card resolves against its own state', async () => {
    const t = clipTarget(trackId, clipId);
    // First touch fires the async query (returns null while pending).
    expect(t.staticHiddenFor!('color.hsl', dev0)).toBeNull();
    expect(t.staticHiddenFor!('color.hsl', dev1)).toBeNull();
    await flush();
    // Now cached — and DISTINCT per device.
    expect(t.staticHiddenFor!('color.hsl', dev0)).toEqual(['saturation']);
    expect(t.staticHiddenFor!('color.hsl', dev1)).toEqual(['lightness']);
  });

  it('falls back to the first device of the type when no instanceKey is given', async () => {
    const t = clipTarget(trackId, clipId);
    t.staticHiddenFor!('color.hsl'); // primes dev0's fingerprint
    await flush();
    expect(t.staticHiddenFor!('color.hsl')).toEqual(['saturation']); // dev0's set
  });
});
