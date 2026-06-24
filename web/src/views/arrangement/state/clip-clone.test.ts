import { describe, it, expect } from 'vitest';
import { store } from './store';

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
});
