import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';
import { ArrColumnAdapter, clipTarget } from '../surfaces/arr-column-adapter';

/**
 * Per-owner automation-field selection: clicking a field selects it for the
 * owning clip/track (distinct from the global focus); the clip-view + track
 * overlay show its envelope; "pin" moves a track field into its own lane.
 */
describe('automation field selection', () => {
  beforeEach(() => {
    store.clearSelection();
    store.selectedAutoField = {};
  });

  it('clip: select a field → its lane is created on ensure + shown', () => {
    const trk = store.addTrack();
    const clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'color.saturate');
    const dev = store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices[0];

    const owner = paths.clip(trk, clip);
    store.selectAutoField(owner, dev.id, 'amount');
    const sel = store.autoField(owner)!;
    expect(sel.deviceId).toBe(dev.id);
    expect(sel.field).toBe('amount');
    expect(sel.label).toContain('amount');

    // No lane yet for the selected field.
    expect(store.selectedClipLane(trk, clip)).toBeUndefined();
    // Ensuring one creates it, targeting the selected field.
    const laneId = store.ensureSelectedClipLane(trk, clip);
    expect(laneId).toBeTruthy();
    const lane = store.selectedClipLane(trk, clip)!;
    expect(lane.id).toBe(laneId);
    expect(lane.targetDeviceId).toBe(dev.id);
    expect(lane.targetField).toBe('amount');
  });

  it('track: select a field → pin creates a lane + clears the selection', () => {
    const trk = store.addTrack();
    store.insertTrackDeviceAt(trk, 0, 'color.saturate');
    const dev = store.trackById(trk)!.sketch.devices[0];

    const owner = paths.track(trk);
    store.selectAutoField(owner, dev.id, 'amount');
    expect(store.selectedTrackLane(trk)).toBeUndefined();
    expect(store.trackById(trk)!.automation.length).toBe(0);

    const laneId = store.pinTrackAutomation(trk);
    expect(laneId).toBeTruthy();
    expect(store.trackById(trk)!.automation.length).toBe(1);
    expect(store.trackById(trk)!.automation[0].targetField).toBe('amount');
    // Selection cleared after pinning (field "moved" into the lane).
    expect(store.autoField(owner)).toBeNull();
  });

  it('adapter selectField parses the field key → per-owner selection, and rebuilds it', () => {
    const trk = store.addTrack();
    const clip = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    store.addClipDeviceType(trk, clip, 'color.saturate'); // device at chainIdx 0
    const dev = store.trackById(trk)!.clips.find((c) => c.id === clip)!.sketch.devices[0];

    const adapter = new ArrColumnAdapter(clipTarget(trk, clip));
    // key = `${sketchId}/${colIdx}/${chainIdx}/${field}`
    adapter.controller.selectField(`clip/${trk}/${clip}/0/0/amount`);
    expect(store.autoField(paths.clip(trk, clip))!.deviceId).toBe(dev.id);
    expect(adapter.controller.selectedFieldKey()).toBe(`clip/${trk}/${clip}/0/0/amount`);

    adapter.controller.selectField(null);
    expect(store.autoField(paths.clip(trk, clip))).toBeNull();
    expect(adapter.controller.selectedFieldKey()).toBeNull();
  });

  it('selection is per-owner (two clips keep independent selections)', () => {
    const trk = store.addTrack();
    const a = store.createEmptyClip(trk, 0, 8)!.split('/')[2];
    const b = store.createEmptyClip(trk, 16, 8)!.split('/')[2];
    store.addClipDeviceType(trk, a, 'color.saturate');
    store.addClipDeviceType(trk, b, 'color.saturate');
    const da = store.trackById(trk)!.clips.find((c) => c.id === a)!.sketch.devices[0];
    const db = store.trackById(trk)!.clips.find((c) => c.id === b)!.sketch.devices[0];
    store.selectAutoField(paths.clip(trk, a), da.id, 'amount');
    store.selectAutoField(paths.clip(trk, b), db.id, 'prescale');
    expect(store.autoField(paths.clip(trk, a))!.field).toBe('amount');
    expect(store.autoField(paths.clip(trk, b))!.field).toBe('prescale');
  });
});
