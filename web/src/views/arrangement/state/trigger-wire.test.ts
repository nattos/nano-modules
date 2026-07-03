import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import { seedTestPlugins } from '../engine/test-plugins';
import type { FieldConnectInfo } from '../../../sketch-types';

/**
 * Trigger wiring in the store: a trigger SOURCE's output → rail becomes a
 * TriggerExport (events, never a scalar RailExport); rail → scene / scene
 * track becomes a triggerRead listen (toggle-off on re-attach); channel
 * display names live per return track. Routed through connectSketchWire —
 * the same entry the WireConnect gesture calls.
 */
describe('trigger wiring', () => {
  const railInfo = (railId: string): FieldConnectInfo =>
    ({ sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
       viewportY: 0, schemaDef: null, railId });
  const trigInfo = (trackId: string, sceneId?: string): FieldConnectInfo =>
    ({ sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
       viewportY: 0, schemaDef: null, triggerTrack: trackId,
       ...(sceneId ? { triggerScene: sceneId } : {}) });
  const fieldInfo = (sketchId: string, chainIdx: number, fieldPath: string, isOutput: boolean): FieldConnectInfo =>
    ({ sketchId, colIdx: 0, chainIdx, fieldPath, isOutput, viewportY: 10, schemaDef: null });

  let hostTrk: string;
  let hostClip: string;
  let trigDev: string;
  let sceneTrk: string;
  let sceneId: string;
  let railId: string;
  let railTrackId: string;

  beforeEach(() => {
    while (store.canUndo) store.undo();
    seedTestPlugins();
    hostTrk = store.addTrack();
    const path = store.createEmptyClip(hostTrk, 0)!;
    hostClip = path.split('/')[2];
    store.addClipDeviceType(hostTrk, hostClip, 'mod.trigger.beat');
    trigDev = store.trackById(hostTrk)!.clips[0].sketch.devices[0].id;
    sceneTrk = store.addSceneTrack();
    sceneId = store.trackById(sceneTrk)!.clips[
      (store.createEmptyClip(sceneTrk, 0), 0)
    ].id;
    railTrackId = store.addReturn();
    railId = store.trackById(railTrackId)!.railId!;
  });

  it('a trigger output → rail creates a TriggerExport (never a scalar export)', () => {
    store.connectSketchWire(
      fieldInfo(`clip/${hostTrk}/${hostClip}`, 0, 'output', true), railInfo(railId));
    const clip = store.trackById(hostTrk)!.clips[0];
    expect(clip.triggerExports?.length).toBe(1);
    expect(clip.triggerExports![0]).toMatchObject({ railId, sourceDeviceId: trigDev });
    expect(clip.exports.length).toBe(0); // no scalar rail export
  });

  it('re-wiring a trigger source replaces its export (one rail per device)', () => {
    const rail2 = store.trackById(store.addReturn())!.railId!;
    store.connectSketchWire(
      fieldInfo(`clip/${hostTrk}/${hostClip}`, 0, 'output', true), railInfo(railId));
    store.connectSketchWire(
      fieldInfo(`clip/${hostTrk}/${hostClip}`, 0, 'output', true), railInfo(rail2));
    const exps = store.trackById(hostTrk)!.clips[0].triggerExports!;
    expect(exps.length).toBe(1);
    expect(exps[0].railId).toBe(rail2);
  });

  it('a non-trigger mod output → rail still creates a scalar RailExport', () => {
    store.addClipDeviceType(hostTrk, hostClip, 'mod.source.lfo');
    store.connectSketchWire(
      fieldInfo(`clip/${hostTrk}/${hostClip}`, 1, 'output', true), railInfo(railId));
    const clip = store.trackById(hostTrk)!.clips[0];
    expect(clip.exports.length).toBe(1);
    expect(clip.triggerExports ?? []).toHaveLength(0);
  });

  it('rail → scene sets a scene-level listen; re-attach toggles it off', () => {
    store.connectSketchWire(railInfo(railId), trigInfo(sceneTrk, sceneId));
    let scene = store.trackById(sceneTrk)!.clips[0];
    expect(scene.triggerRead?.railId).toBe(railId);
    // Same rail again → detach (back to the track default / global bus).
    store.connectSketchWire(railInfo(railId), trigInfo(sceneTrk, sceneId));
    scene = store.trackById(sceneTrk)!.clips[0];
    expect(scene.triggerRead).toBeUndefined();
  });

  it('rail → scene TRACK sets the track default listen', () => {
    store.connectSketchWire(railInfo(railId), trigInfo(sceneTrk));
    expect(store.trackById(sceneTrk)!.triggerRead?.railId).toBe(railId);
    expect(store.trackById(sceneTrk)!.clips[0].triggerRead).toBeUndefined();
  });

  it('a trigger listen on a non-scene track is rejected', () => {
    store.connectSketchWire(railInfo(railId), trigInfo(hostTrk));
    expect(store.trackById(hostTrk)!.triggerRead).toBeUndefined();
  });

  it('removeTriggerExport returns the source to the global bus', () => {
    store.connectSketchWire(
      fieldInfo(`clip/${hostTrk}/${hostClip}`, 0, 'output', true), railInfo(railId));
    store.removeTriggerExport(hostTrk, hostClip, trigDev);
    expect(store.trackById(hostTrk)!.clips[0].triggerExports ?? []).toHaveLength(0);
  });

  it('trigger channel names live per return track (empty clears)', () => {
    store.setTriggerChannelName(railTrackId, 3, 'Kick');
    expect(store.trackById(railTrackId)!.triggerChannelNames).toEqual({ '3': 'Kick' });
    store.setTriggerChannelName(railTrackId, 3, '  ');
    expect(store.trackById(railTrackId)!.triggerChannelNames).toBeUndefined();
  });
});
