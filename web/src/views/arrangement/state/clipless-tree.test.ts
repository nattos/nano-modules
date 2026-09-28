import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { Track } from '../model/composition';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

/**
 * Clipless layers in compositeTreeAtBeat (comp_eval.h twin): a timeline track
 * with NO clips whose own sketch holds devices is a `clipless` leaf at every
 * beat; an empty sketch contributes nothing; any clip at all restores the
 * track sketch's FX-bus role.
 */
describe('compositeTreeAtBeat — clipless layers', () => {
  let t: Track;

  beforeEach(() => {
    if (!store.composition.tracks.some((x) => x.kind === 'track')) store.addTrack();
    for (const x of store.composition.tracks) {
      x.soloed = false; x.bypassed = false; x.parentId = null;
      if (x.kind === 'track') { x.clips = []; x.sketch.devices = []; x.sketch.wires = []; }
    }
    t = store.composition.tracks.find((x) => x.kind === 'track')!;
  });

  const cliplessIds = (beat: number) =>
    store.compositeTreeAtBeat(beat)
      .filter((n) => n.type === 'clipless')
      .map((n) => (n.type === 'clipless' ? n.track.id : ''));

  it('a clipless track with a sketch is a leaf at any beat', () => {
    store.insertTrackDeviceAt(t.id, 0, 'color.hsl');
    expect(cliplessIds(0)).toContain(t.id);
    expect(cliplessIds(1000)).toContain(t.id);
  });

  it('an empty sketch is no layer', () => {
    expect(cliplessIds(0)).not.toContain(t.id);
  });

  it('a track with a clip keeps its FX-bus role (no clipless leaf)', () => {
    store.insertTrackDeviceAt(t.id, 0, 'color.hsl');
    store.createEmptyClip(t.id, 100, 4);
    expect(cliplessIds(0)).not.toContain(t.id);
  });

  it('bypass and solo apply as for any leaf', () => {
    store.insertTrackDeviceAt(t.id, 0, 'color.hsl');
    t.bypassed = true;
    expect(cliplessIds(0)).not.toContain(t.id);
    t.bypassed = false;
    const other = store.composition.tracks.find((x) => x.kind === 'track' && x.id !== t.id);
    if (other) {
      other.soloed = true;
      expect(cliplessIds(0)).not.toContain(t.id);
      other.soloed = false;
    }
  });
});
