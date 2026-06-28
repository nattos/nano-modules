import { describe, it, expect } from 'vitest';
import { store } from './store';
import { seedTestPlugins } from "../engine/test-plugins";
seedTestPlugins(); // offline registry: catalogEffect resolves source/effect roles

/**
 * Duplicating a clip (cmd-drag → insertClipClone, paste, split) must mint FRESH
 * inner ids. Shared device ids collide on the composite instance key (instance
 * retype storm); shared automation-lane ids route envelope edits to the wrong
 * clip (laneIn resolves globally) → edits snap back.
 */
describe('clip duplication mints fresh inner ids', () => {
  it('a cloned clip shares NO device or lane id with its source', () => {
    const t1 = store.addTrack();
    const clipPath = store.createEmptyClip(t1, 0, 8)!;
    const clipId = clipPath.split('/')[2];
    store.addClipDeviceType(t1, clipId, 'color.tone.brightness_contrast');
    const src = store.trackById(t1)!.clips.find((c) => c.id === clipId)!;
    const srcDevId = src.sketch.devices[0].id;
    // Give it an automation lane (so we can check lane-id freshness).
    store.selectAutoField(clipPath, srcDevId, 'brightness');
    const srcLaneId = store.ensureSelectedClipLane(t1, clipId);

    store.insertClipClone(t1, store.trackById(t1)!.clips.find((c) => c.id === clipId)!);
    // The clone is the clip with a fresh id (it carves the source at the same spot).
    const clone = store.trackById(t1)!.clips.find((c) => c.id !== clipId && c.sketch.devices.length > 0)!;
    expect(clone).toBeDefined();
    // Distinct clip id, distinct device id, distinct lane id.
    expect(clone.id).not.toBe(clipId);
    expect(clone.sketch.devices[0].id).not.toBe(srcDevId);
    expect(clone.automation?.[0]?.id).toBeDefined();
    expect(clone.automation![0].id).not.toBe(srcLaneId);
    // The clone's lane still targets the clone's OWN (remapped) device.
    expect(clone.automation![0].targetDeviceId).toBe(clone.sketch.devices[0].id);
  });

  it('a cloned clip remaps its rail exports/reads to the new devices + ids', () => {
    const t1 = store.addTrack();
    const clipPath = store.createEmptyClip(t1, 0, 8)!;
    const clipId = clipPath.split('/')[2];
    store.addClipDeviceType(t1, clipId, 'color.tone.brightness_contrast');
    const src = store.trackById(t1)!.clips.find((c) => c.id === clipId)!;
    const srcDevId = src.sketch.devices[0].id;
    const railId = store.trackById(store.addReturn())!.railId!;
    // An export (device output → rail) and a read (rail → device input).
    store.connectSketchWire(
      { sketchId: `clip/${t1}/${clipId}`, colIdx: 0, chainIdx: 0, fieldPath: 'brightness', isOutput: true, viewportY: 0, schemaDef: null },
      { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0, schemaDef: null, railId });
    store.connectSketchWire(
      { sketchId: `clip/${t1}/${clipId}`, colIdx: 0, chainIdx: 0, fieldPath: 'contrast', isOutput: false, viewportY: 0, schemaDef: null },
      { sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0, schemaDef: null, railId });
    const srcNow = store.trackById(t1)!.clips.find((c) => c.id === clipId)!;
    const srcExpId = srcNow.exports[0].id;
    const srcReadId = srcNow.reads![0].id;

    store.insertClipClone(t1, store.trackById(t1)!.clips.find((c) => c.id === clipId)!);
    const clone = store.trackById(t1)!.clips.find((c) => c.id !== clipId && c.sketch.devices.length > 0)!;
    const cloneDevId = clone.sketch.devices[0].id;

    // Tap ids are fresh (they key the w:/r: wire selection path → must not alias).
    expect(clone.exports[0].id).not.toBe(srcExpId);
    expect(clone.reads![0].id).not.toBe(srcReadId);
    // Device refs point at the clone's OWN device, not the source's.
    expect(cloneDevId).not.toBe(srcDevId);
    expect(clone.exports[0].sourceDeviceId).toBe(cloneDevId);
    expect(clone.reads![0].targetDeviceId).toBe(cloneDevId);
    // The rail target is preserved (both still modulate the same return).
    expect(clone.exports[0].railId).toBe(railId);
  });

  it('single-clip cmd-drag copy is ONE undo and leaves the original intact', () => {
    const t1 = store.addTrack();
    const clipId = store.createEmptyClip(t1, 0, 4)!.split('/')[2];
    const src = JSON.parse(JSON.stringify(store.trackById(t1)!.clips.find((c) => c.id === clipId)));
    const before = store.trackById(t1)!.clips.length;
    // Two drag frames under the same coalesce key (simulating the live drag).
    store.beginGesture();
    store.insertClipCopyAt(src, t1, 8, `dup:${clipId}`);
    store.insertClipCopyAt(src, t1, 12, `dup:${clipId}`);
    store.endGesture();
    const tr = store.trackById(t1)!;
    expect(tr.clips.length).toBe(before + 1); // original + ONE copy (coalesced)
    expect(tr.clips.some((c) => c.id === clipId)).toBe(true); // original untouched
    const copy = tr.clips.find((c) => c.id !== clipId)!;
    expect(copy.startBeat).toBe(12); // last frame's position won
    expect(copy.id).not.toBe(clipId);
    // A SINGLE undo fully reverts the duplicate (not two).
    store.undo();
    const tr2 = store.trackById(t1)!;
    expect(tr2.clips.length).toBe(before);
    expect(tr2.clips.some((c) => c.id === clipId)).toBe(true);
  });

  it('copyTimeBoxContent duplicates EVERY in-box clip, leaving the originals', () => {
    const t1 = store.addTrack();
    const t2 = store.addTrack();
    store.createEmptyClip(t1, 0, 4);
    store.createEmptyClip(t2, 0, 4);
    store.beginGesture();
    store.copyTimeBoxContent(8, 0, { start: 0, end: 4, scope: [t1, t2] });
    store.endGesture();
    // Each track keeps its original [0,4] and gains a copy at [8,12].
    for (const t of [t1, t2]) {
      const clips = store.trackById(t)!.clips;
      expect(clips.length).toBe(2);
      expect(clips.some((c) => Math.abs(c.startBeat) < 1e-6)).toBe(true); // original
      expect(clips.some((c) => Math.abs(c.startBeat - 8) < 1e-6)).toBe(true); // copy
    }
    // One undo removes all copies.
    store.undo();
    expect(store.trackById(t1)!.clips.length).toBe(1);
    expect(store.trackById(t2)!.clips.length).toBe(1);
  });
});
