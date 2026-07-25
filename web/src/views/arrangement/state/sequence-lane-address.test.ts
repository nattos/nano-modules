import { describe, it, expect } from 'vitest';
import { store, paths } from './store';
import { isSequenceClip } from '../model/composition';
import { laneById, clipIn, isSequenceLaneId, laneIdOfClip } from './lane-resolve';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins();

/**
 * A sequence clip's interior lane is a real `Track` with a globally-unique
 * uid('track') id, so every `(trackId, clipId)` store op addresses interior
 * sub-clips unchanged — as long as lookups resolve through `laneById`/`clipIn`
 * rather than `trackById` (which stays deliberately top-level-only).
 */

function makeSequence() {
  const t = store.addTrack();
  store.createEmptyClip(t, 0, 4);
  store.createEmptyClip(t, 4, 4);
  store.setTimeSelection(0, 8, [t]);
  store.consolidateSelection();
  const seq = store.trackById(t)!.clips.find(isSequenceClip)!;
  const lane = seq.sequence!;
  return { trackId: t, seqId: seq.id, laneId: lane.id, subId: lane.clips[0].id };
}

describe('lane resolution', () => {
  it('trackById does NOT see an interior lane; laneById does', () => {
    const { laneId } = makeSequence();
    expect(store.trackById(laneId)).toBeUndefined();
    expect(store.laneById(laneId)).toBeDefined();
    expect(store.isSequenceLaneId(laneId)).toBe(true);
  });

  it('a top-level track id resolves through laneById unchanged', () => {
    const { trackId } = makeSequence();
    expect(store.laneById(trackId)).toBe(store.trackById(trackId));
    expect(store.isSequenceLaneId(trackId)).toBe(false);
  });

  it('clipByPath / clipIn resolve an interior sub-clip', () => {
    const { laneId, subId } = makeSequence();
    expect(store.clipIn(laneId, subId)).toBeDefined();
    const found = store.clipByPath(paths.clip(laneId, subId));
    expect(found?.clip.id).toBe(subId);
    expect(found?.track.id).toBe(laneId);
    expect(store.laneIdOfClip(subId)).toBe(laneId);
  });

  it('the pure resolvers agree with the store methods', () => {
    const { laneId, subId } = makeSequence();
    const comp = store.composition;
    expect(laneById(comp, laneId)?.id).toBe(laneId);
    expect(clipIn(comp, laneId, subId)?.id).toBe(subId);
    expect(isSequenceLaneId(comp, laneId)).toBe(true);
    expect(laneIdOfClip(comp, subId)).toBe(laneId);
  });

  it('the interior index survives edits (memoized on docRev)', () => {
    const { trackId, laneId } = makeSequence();
    expect(store.laneById(laneId)).toBeDefined();
    store.createEmptyClip(trackId, 32, 4); // bump docRev
    expect(store.laneById(laneId)).toBeDefined();
  });
});

describe('clip ops address interior sub-clips', () => {
  it('rename / resize / move / bypass all land on the sub-clip', () => {
    const { laneId, subId } = makeSequence();

    store.renameClip(laneId, subId, 'Inner');
    expect(store.clipIn(laneId, subId)!.name).toBe('Inner');

    store.moveClip(laneId, subId, 1);
    expect(store.clipIn(laneId, subId)!.startBeat).toBe(1);

    store.resizeClip(laneId, subId, 1, 2);
    expect(store.clipIn(laneId, subId)!.lengthBeat).toBe(2);

    store.toggleClipBypass(laneId, subId);
    expect(store.clipIn(laneId, subId)!.bypassed).toBe(true);
  });

  it('device chain edits land on the sub-clip', () => {
    const { laneId, subId } = makeSequence();
    store.addClipDeviceType(laneId, subId, 'color.saturate');
    const devs = store.clipIn(laneId, subId)!.sketch.devices;
    expect(devs.map((d) => d.moduleType)).toEqual(['color.saturate']);

    store.setClipDeviceField(laneId, subId, devs[0].id, 'amount', 0.5);
    expect(store.clipIn(laneId, subId)!.sketch.devices[0].state!.amount).toBe(0.5);

    store.removeClipDevice(laneId, subId, devs[0].id);
    expect(store.clipIn(laneId, subId)!.sketch.devices).toHaveLength(0);
  });

  it('the interior lane has its own FX bus, editable via track/<laneId>', () => {
    const { laneId } = makeSequence();
    store.insertTrackDeviceAt(laneId, 0, 'color.saturate');
    expect(store.laneById(laneId)!.sketch.devices.map((d) => d.moduleType))
      .toEqual(['color.saturate']);
    expect(store.sketchWires(`track/${laneId}`)).toEqual([]);
  });

  it('a clip never crosses the interior boundary on a move', () => {
    const { trackId, laneId, subId } = makeSequence();
    const innerBefore = store.laneById(laneId)!.clips.length;

    store.moveClipToTrack(laneId, subId, trackId, 40);

    // The sub-clip stayed inside; the outer track gained nothing.
    expect(store.laneById(laneId)!.clips).toHaveLength(innerBefore);
    expect(store.clipIn(laneId, subId)).toBeDefined();
    expect(store.trackById(trackId)!.clips.some((c) => c.id === subId)).toBe(false);
  });
});

describe('the global caret never sees an interior lane id', () => {
  /**
   * REGRESSION LOCK. `caretRowSpan()` matches the caret's anchor/head against
   * TOP-LEVEL rows; if neither matches it returns [], `caretTrackIds` returns
   * [], and an empty scope means "global" — so a single stray interior lane id
   * in the caret would silently widen ⌘E / ⌘J / Delete to EVERY track.
   */
  it('selecting a sub-clip leaves the caret scope untouched', () => {
    const { trackId, laneId, subId } = makeSequence();
    store.setTimeSelection(0, 8, [trackId]);
    const scopeBefore = [...store.caretTrackIds];
    const boxBefore = [store.timeSelStart, store.timeSelEnd];

    store.select(paths.clip(laneId, subId));

    expect(store.caretTrackIds).toEqual(scopeBefore);
    expect([store.timeSelStart, store.timeSelEnd]).toEqual(boxBefore);
    // The selection itself DID move (it's selection-only, not a no-op).
    expect(store.primaryPath).toBe(paths.clip(laneId, subId));
  });

  it('moving/resizing a sub-clip leaves the caret scope untouched', () => {
    const { trackId, laneId, subId } = makeSequence();
    store.setTimeSelection(0, 8, [trackId]);
    const scopeBefore = [...store.caretTrackIds];

    store.moveClip(laneId, subId, 2);
    store.resizeClip(laneId, subId, 2, 3);

    expect(store.caretTrackIds).toEqual(scopeBefore);
    expect(store.caretTrackIds).not.toContain(laneId);
  });

  it('a caret naming a non-row lane yields NO region scope, never "all tracks"', () => {
    const a = store.addTrack();
    const b = store.addTrack();
    store.createEmptyClip(a, 0, 8);
    store.createEmptyClip(b, 0, 8);
    const { laneId } = makeSequence();

    // Force the pathological state the guard exists for.
    store.setCaret({
      anchorBeat: 0, anchorTrackId: laneId,
      headBeat: 8, headTrackId: laneId,
    });
    expect(store.caretTrackIds).toEqual([]);

    // Split must act on NOTHING, not on every track in the document.
    const before = [a, b].map((t) => store.trackById(t)!.clips.length);
    store.splitAtCursor();
    expect([a, b].map((t) => store.trackById(t)!.clips.length)).toEqual(before);
  });
});
