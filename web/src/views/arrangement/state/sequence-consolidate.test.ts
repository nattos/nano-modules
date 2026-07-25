import { describe, it, expect } from 'vitest';
import { store } from './store';
import { isSequenceClip, sequenceInteriorBeats } from '../model/composition';
import { duplicateDocIds } from './lane-resolve';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins(); // offline registry: catalogEffect resolves source/effect roles

/**
 * Consolidate (⌘J) gathers a time region into ONE sequence clip per in-scope
 * track — Ableton's "Consolidate", and the conceptual inverse of Split (⌘E).
 */

/** Select a beat region across one track (the same inputs Split uses). */
function region(trackId: string, start: number, end: number) {
  store.setTimeSelection(start, end, [trackId]);
}

function laneOf(trackId: string, clipId: string) {
  return store.clipIn(trackId, clipId)!.sequence!;
}

/** The single sequence clip on a track (fails loudly if there isn't exactly one). */
function soleSequence(trackId: string) {
  const seqs = store.trackById(trackId)!.clips.filter(isSequenceClip);
  expect(seqs).toHaveLength(1);
  return seqs[0];
}

describe('consolidateSelection', () => {
  it('gathers the region into one sequence clip, rebasing sub-clips lane-locally', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 4);
    store.createEmptyClip(t, 4, 4);
    region(t, 0, 8);
    store.consolidateSelection();

    const seq = soleSequence(t);
    expect(store.trackById(t)!.clips).toHaveLength(1); // the originals moved inside
    expect(seq.startBeat).toBe(0);
    expect(seq.lengthBeat).toBe(8);
    expect(seq.kind).toBe('sequence');
    const lane = laneOf(t, seq.id);
    expect(lane.clips.map((c) => c.startBeat)).toEqual([0, 4]);
    expect(sequenceInteriorBeats(seq)).toBe(8);
  });

  it('rebases relative to the region start, not to beat 0', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 16, 4);
    store.createEmptyClip(t, 20, 4);
    region(t, 16, 24);
    store.consolidateSelection();

    const seq = soleSequence(t);
    expect(seq.startBeat).toBe(16);
    // Lane-local: 0 is the sequence clip's LEFT EDGE, not the arrangement origin.
    expect(laneOf(t, seq.id).clips.map((c) => c.startBeat)).toEqual([0, 4]);
  });

  it('splits a straddling clip and absorbs only the in-range piece', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 16); // straddles the region's right edge
    region(t, 0, 8);
    store.consolidateSelection();

    const seq = soleSequence(t);
    expect(seq.lengthBeat).toBe(8);
    const lane = laneOf(t, seq.id);
    expect(lane.clips).toHaveLength(1);
    expect(lane.clips[0].lengthBeat).toBe(8);
    // The out-of-range tail stays on the timeline as an ordinary clip.
    const outside = store.trackById(t)!.clips.filter((c) => !isSequenceClip(c));
    expect(outside).toHaveLength(1);
    expect(outside[0].startBeat).toBe(8);
    expect(outside[0].lengthBeat).toBe(8);
  });

  it('still creates an EMPTY sequence clip of that length for an empty region', () => {
    const t = store.addTrack();
    region(t, 0, 8);
    store.consolidateSelection();

    const seq = soleSequence(t);
    expect(seq.lengthBeat).toBe(8);
    expect(laneOf(t, seq.id).clips).toHaveLength(0);
  });

  it('makes one sequence clip PER TRACK, with distinct lane ids', () => {
    const a = store.addTrack();
    const b = store.addTrack();
    store.createEmptyClip(a, 0, 4);
    store.createEmptyClip(b, 0, 4);
    store.setTimeSelection(0, 8, [a, b]);
    store.consolidateSelection();

    const sa = soleSequence(a);
    const sb = soleSequence(b);
    expect(sa.id).not.toBe(sb.id);
    expect(sa.sequence!.id).not.toBe(sb.sequence!.id);
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });

  it('skips scene tracks (their cells are rigid launchable slots)', () => {
    const s = store.addSceneTrack();
    store.createEmptyClip(s, 0, 4);
    const before = store.trackById(s)!.clips.length;
    store.setTimeSelection(0, 8, [s]);
    store.consolidateSelection();

    expect(store.trackById(s)!.clips).toHaveLength(before);
    expect(store.trackById(s)!.clips.some(isSequenceClip)).toBe(false);
  });

  it('is one undo entry that restores the lane exactly', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 4);
    store.createEmptyClip(t, 4, 4);
    const before = JSON.stringify(store.trackById(t)!.clips);
    region(t, 0, 8);
    store.consolidateSelection();
    expect(store.trackById(t)!.clips.some(isSequenceClip)).toBe(true);

    store.undo();
    expect(JSON.stringify(store.trackById(t)!.clips)).toBe(before);
  });

  it('falls back to the selected clips’ union extent with no time box', () => {
    const t = store.addTrack();
    const p1 = store.createEmptyClip(t, 4, 4)!;
    const p2 = store.createEmptyClip(t, 8, 4)!;
    store.clearTimeSelection();
    store.setSelection([p1, p2]);
    expect(store.hasTimeSelection).toBe(false);
    store.consolidateSelection();

    const seq = soleSequence(t);
    expect(seq.startBeat).toBe(4);
    expect(seq.lengthBeat).toBe(8);
  });
});

describe('consolidate absorbs existing sequence clips without nesting', () => {
  it('breaks an inner sequence clip first — never nests', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 4);
    store.createEmptyClip(t, 4, 4);
    region(t, 0, 8);
    store.consolidateSelection(); // first sequence: 2 sub-clips

    store.createEmptyClip(t, 8, 4);
    region(t, 0, 12);
    store.consolidateSelection(); // absorbs the sequence + the new clip

    const seq = soleSequence(t);
    const lane = laneOf(t, seq.id);
    // 2 lifted from the broken sequence + 1 new = 3, and NONE is a sequence.
    expect(lane.clips).toHaveLength(3);
    expect(lane.clips.some(isSequenceClip)).toBe(false);
    expect(lane.clips.map((c) => c.startBeat)).toEqual([0, 4, 8]);
  });

  it('concatenates absorbed chains left→right and dedupes identical ones', () => {
    // Two sequence clips carrying DIFFERENT chains → both, in timeline order.
    const t = store.addTrack();
    for (const [start, moduleType] of [
      [0, 'color.tone.brightness_contrast'],
      [8, 'color.saturate'],
    ] as const) {
      store.createEmptyClip(t, start, 8);
      region(t, start, start + 8);
      store.consolidateSelection();
      const s = store.trackById(t)!.clips.find(
        (c) => isSequenceClip(c) && c.startBeat === start)!;
      store.addClipDeviceType(t, s.id, moduleType);
    }
    region(t, 0, 16);
    store.consolidateSelection();

    const merged = soleSequence(t);
    expect(merged.sketch.devices.map((d) => d.moduleType))
      .toEqual(['color.tone.brightness_contrast', 'color.saturate']);
    // Fresh device ids, and the doc stays collision-free.
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });

  it('keeps ONE copy when the absorbed chains are exactly equal', () => {
    const t = store.addTrack();
    for (const start of [0, 8]) {
      store.createEmptyClip(t, start, 8);
      region(t, start, start + 8);
      store.consolidateSelection();
      const s = store.trackById(t)!.clips.find(
        (c) => isSequenceClip(c) && c.startBeat === start)!;
      store.addClipDeviceType(t, s.id, 'color.saturate');
    }
    region(t, 0, 16);
    store.consolidateSelection();

    // Same module type AND same default params ⇒ structurally identical ⇒ one.
    expect(soleSequence(t).sketch.devices.map((d) => d.moduleType))
      .toEqual(['color.saturate']);
  });

  it('treats a differing PARAM as a different chain (both kept)', () => {
    const t = store.addTrack();
    for (const [start, brightness] of [[0, 0.25], [8, 0.75]] as const) {
      store.createEmptyClip(t, start, 8);
      region(t, start, start + 8);
      store.consolidateSelection();
      const s = store.trackById(t)!.clips.find(
        (c) => isSequenceClip(c) && c.startBeat === start)!;
      store.addClipDeviceType(t, s.id, 'color.tone.brightness_contrast');
      const devId = store.clipIn(t, s.id)!.sketch.devices[0].id;
      store.setClipDeviceField(t, s.id, devId, 'brightness', brightness);
    }
    region(t, 0, 16);
    store.consolidateSelection();

    expect(soleSequence(t).sketch.devices).toHaveLength(2);
  });
});

describe('uncollapseSelection', () => {
  it('lifts sub-clips back to absolute beats and drops the sequence clip', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 16, 4);
    store.createEmptyClip(t, 20, 4);
    region(t, 16, 24);
    store.consolidateSelection();
    store.uncollapseSelection();

    const clips = store.trackById(t)!.clips.sort((a, b) => a.startBeat - b.startBeat);
    expect(clips.some(isSequenceClip)).toBe(false);
    expect(clips.map((c) => c.startBeat)).toEqual([16, 20]);
  });

  it('fans the sequence’s own chain onto each lifted sub-clip', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 4);
    store.createEmptyClip(t, 4, 4);
    region(t, 0, 8);
    store.consolidateSelection();
    const seq = soleSequence(t);
    store.addClipDeviceType(t, seq.id, 'color.saturate');

    store.uncollapseSelection();
    const clips = store.trackById(t)!.clips;
    expect(clips).toHaveLength(2);
    for (const c of clips) {
      expect(c.sketch.devices.map((d) => d.moduleType)).toEqual(['color.saturate']);
    }
    // Fanned copies must not share device ids with each other.
    expect(duplicateDocIds(store.composition)).toEqual([]);
  });

  it('round-trips: consolidate → uncollapse restores the original spans', () => {
    const t = store.addTrack();
    store.createEmptyClip(t, 0, 4);
    store.createEmptyClip(t, 4, 4);
    store.createEmptyClip(t, 8, 4);
    const before = store.trackById(t)!.clips
      .map((c) => [c.startBeat, c.lengthBeat]).sort((a, b) => a[0] - b[0]);

    region(t, 0, 12);
    store.consolidateSelection();
    store.uncollapseSelection();

    const after = store.trackById(t)!.clips
      .map((c) => [c.startBeat, c.lengthBeat]).sort((a, b) => a[0] - b[0]);
    expect(after).toEqual(before);
  });
});
