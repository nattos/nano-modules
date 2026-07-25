import { describe, it, expect } from 'vitest';
import { store, paths } from './store';
import { isSequenceClip } from '../model/composition';
import { duplicateDocIds } from './lane-resolve';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins();

/**
 * Cloning a SEQUENCE clip must mint fresh ids all the way down: the interior
 * lane id, every sub-clip id, and every device id inside them.
 *
 * This is the one test class that catches a genuinely silent failure. Engine
 * instance keys are built from these ids (`clip_<id>_<dev>`,
 * `track_<laneId>_<dev>`), and the native `Builder::push` (sketch_build.h)
 * DROPS a duplicate instance key without logging — so a clone that shares ids
 * with its source renders BLACK with no error anywhere in either host.
 */

/** Build a sequence clip on a fresh track: 2 sub-clips, each with an effect,
 *  plus an effect on the sequence clip's own chain. */
function makeSequence(): { trackId: string; clip: ReturnType<typeof store.clipIn> } {
  const t = store.addTrack();
  const p1 = store.createEmptyClip(t, 0, 4)!;
  const p2 = store.createEmptyClip(t, 4, 4)!;
  store.addClipDeviceType(t, p1.split('/')[2], 'color.saturate');
  store.addClipDeviceType(t, p2.split('/')[2], 'color.tone.brightness_contrast');
  store.setTimeSelection(0, 8, [t]);
  store.consolidateSelection();
  const seq = store.trackById(t)!.clips.find(isSequenceClip)!;
  store.addClipDeviceType(t, seq.id, 'color.saturate'); // the sequence's OWN chain
  return { trackId: t, clip: store.clipIn(t, seq.id) };
}

/** Every id a clone must not share: lane, sub-clips, and their devices. */
function idsOf(clip: NonNullable<ReturnType<typeof store.clipIn>>): string[] {
  const lane = clip.sequence!;
  return [
    clip.id,
    lane.id,
    ...clip.sketch.devices.map((d) => d.id),
    ...lane.clips.flatMap((c) => [c.id, ...c.sketch.devices.map((d) => d.id)]),
  ];
}

function expectDisjoint(a: string[], b: string[]) {
  const overlap = a.filter((id) => b.includes(id));
  expect(overlap).toEqual([]);
}

describe('cloning a sequence clip mints fresh interior ids', () => {
  it('insertClipClone re-mints the lane, sub-clips and their devices', () => {
    const { trackId, clip } = makeSequence();
    const before = idsOf(clip!);

    // insertClipClone drops the copy on the SAME span, so it carves the source
    // away — the surviving clip is the clone (see clip-clone.test.ts).
    store.insertClipClone(trackId, store.clipIn(trackId, clip!.id)!);

    const clone = store.trackById(trackId)!.clips.find(isSequenceClip)!;
    expect(clone.id).not.toBe(clip!.id);
    expectDisjoint(idsOf(clone), before);
    // The clone carries the same STRUCTURE (2 sub-clips + its own chain).
    expect(clone.sequence!.clips).toHaveLength(2);
    expect(clone.sketch.devices).toHaveLength(1);
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });

  it('insertClipCopyAt re-mints the whole interior', () => {
    const { trackId, clip } = makeSequence();
    store.insertClipCopyAt(store.clipIn(trackId, clip!.id)!, trackId, 32);

    const seqs = store.trackById(trackId)!.clips.filter(isSequenceClip);
    expect(seqs.length).toBe(2);
    expectDisjoint(idsOf(seqs[0]), idsOf(seqs[1]));
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });

  it('copy + paste re-mints the whole interior', () => {
    const { trackId, clip } = makeSequence();
    store.selectClipOnly(paths.clip(trackId, clip!.id));
    expect(store.copyClips()).toBe(true);
    store.clearTimeSelection();
    store.setPlayFrom(32);
    store.pasteClips();

    const seqs = store.trackById(trackId)!.clips.filter(isSequenceClip);
    expect(seqs.length).toBe(2);
    expectDisjoint(idsOf(seqs[0]), idsOf(seqs[1]));
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });

  it('splitting a sequence clip gives the right half a fresh interior', () => {
    const { trackId, clip } = makeSequence();
    store.setTimeSelection(4, 4, [trackId]); // zero-width caret at beat 4
    store.splitAtCursor();

    const seqs = store.trackById(trackId)!.clips.filter(isSequenceClip);
    expect(seqs.length).toBe(2);
    expectDisjoint(idsOf(seqs[0]), idsOf(seqs[1]));
    expect(duplicateDocIds(store.composition)).toEqual([]);
    expect(clip).toBeDefined();
  });

  it('freshens clip.transport device ids too (they key their own instances)', () => {
    const t = store.addTrack();
    const p = store.createEmptyClip(t, 0, 8)!;
    const clipId = p.split('/')[2];
    store.addClipTransportDevice(t, clipId, 'core.transport.time');
    const srcDev = store.clipIn(t, clipId)!.transport!.devices[0].id;

    store.insertClipClone(t, store.clipIn(t, clipId)!);
    const clone = store.trackById(t)!.clips.find(
      (c) => c.id !== clipId && !!c.transport?.devices.length)!;
    expect(clone.transport!.devices[0].id).not.toBe(srcDev);
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });
});
