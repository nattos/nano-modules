import { describe, it, expect, beforeEach } from 'vitest';
import { store } from '../state/store';
import { buildClipFieldBinding } from './arr-column-adapter';
import { clipInstanceKey } from '../engine/clip-sketch';

/**
 * buildClipFieldBinding — the standalone FieldBinding the dashboard knobs/sparks
 * use. Reads/writes clip device state through the store and surfaces live
 * modulation telemetry (keyed by the engine instance key).
 */
describe('buildClipFieldBinding', () => {
  let trackId: string;
  let clipId: string;
  let deviceId: string;

  beforeEach(() => {
    store.modulationData = {};
    const track = store.composition.tracks.find((t) => t.kind === 'track')!;
    trackId = track.id;
    const path = store.createEmptyClip(trackId, 0, 8);
    clipId = path.split('/')[2];
    store.addClipDeviceType(trackId, clipId, 'color.hsl');
    deviceId = store.clipByPath(path)!.clip.sketch.devices[0].id;
  });

  it('reads the catalog default, then the written value', () => {
    const b = buildClipFieldBinding(trackId, clipId, deviceId);
    expect(b.getValue('hue_shift')).toBe(0); // color.hsl default
    store.setClipDeviceField(trackId, clipId, deviceId, 'hue_shift', 0.3);
    expect(b.getValue('hue_shift')).toBeCloseTo(0.3, 6);
  });

  it('setValue writes through to device state', () => {
    const b = buildClipFieldBinding(trackId, clipId, deviceId);
    b.setValue('saturation', -0.4);
    expect(store.clipByPath(`clip/${trackId}/${clipId}`)!.clip.sketch.devices[0].state!.saturation)
      .toBeCloseTo(-0.4, 6);
  });

  it('getModulation reads the telemetry keyed by the engine instance key', () => {
    const b = buildClipFieldBinding(trackId, clipId, deviceId);
    expect(b.getModulation!('hue_shift')).toBeNull();
    const band = { value: 0.6, min: -1, max: 1, neutral: 0 };
    store.modulationData[clipInstanceKey(clipId, deviceId)] = { hue_shift: band };
    expect(b.getModulation!('hue_shift')).toEqual(band);
  });

  it('continuous edit previews live and cancel reverts', () => {
    store.setClipDeviceField(trackId, clipId, deviceId, 'lightness', 0.2);
    const b = buildClipFieldBinding(trackId, clipId, deviceId);
    const h = b.beginContinuousEdit('lightness', 0.5);
    h.update(0.8);
    expect(b.getValue('lightness')).toBeCloseTo(0.8, 6);
    h.cancel();
    expect(b.getValue('lightness')).toBeCloseTo(0.2, 6);
  });
});
