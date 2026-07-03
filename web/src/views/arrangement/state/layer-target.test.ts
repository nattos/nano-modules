import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import { LAYER_TARGET_ID } from '../model/composition';
import type { FieldConnectInfo } from '../../../sketch-types';

/**
 * The __layer__ composition-param vocabulary in the store: wiring a track/group
 * LAYER endpoint (the mixer strip) to rails and to same-track modulation
 * outputs, plus the automation field-select labels. Routed through
 * connectSketchWire — the same entry the WireConnect gesture calls.
 */
describe('layer (__layer__) wiring + automation targets', () => {
  const railInfo = (railId: string): FieldConnectInfo =>
    ({ sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
       viewportY: 0, schemaDef: null, railId });
  const layerInfo = (ownerId: string, layerField = 'opacity'): FieldConnectInfo =>
    ({ sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false,
       viewportY: 0, schemaDef: null, layerOwner: ownerId, layerField });
  const fieldInfo = (sketchId: string, fieldPath: string, isOutput: boolean): FieldConnectInfo =>
    ({ sketchId, colIdx: 0, chainIdx: 0, fieldPath, isOutput, viewportY: 10, schemaDef: null });

  let trk: string;
  let clipId: string;
  let devId: string;
  let railId: string;

  beforeEach(() => {
    trk = store.addTrack();
    store.addVideoClip(trk, 0, { sourceKey: 'k', url: 'blob:x', frameCount: 30, fps: 30, label: 'v' }, 4);
    const clip = store.trackById(trk)!.clips[0];
    clipId = clip.id;
    devId = clip.sketch.devices[0].id;
    railId = store.trackById(store.addReturn())!.railId!;
  });

  it('a rail dropped on a layer endpoint creates a TRACK-level read', () => {
    store.connectSketchWire(railInfo(railId), layerInfo(trk));
    const reads = store.trackById(trk)!.reads ?? [];
    expect(reads.length).toBe(1);
    expect(reads[0].railId).toBe(railId);
    expect(reads[0].targetDeviceId).toBe(LAYER_TARGET_ID);
    expect(reads[0].targetField).toBe('opacity');
    expect(reads[0].combine).toBe('replace');
  });

  it('re-attaching replaces the layer read (one per field)', () => {
    const rail2 = store.trackById(store.addReturn())!.railId!;
    store.connectSketchWire(railInfo(railId), layerInfo(trk));
    store.connectSketchWire(railInfo(rail2), layerInfo(trk));
    const reads = store.trackById(trk)!.reads ?? [];
    expect(reads.length).toBe(1);
    expect(reads[0].railId).toBe(rail2);
  });

  it('a bypass layer↔rail connect is stored with targetField bypass', () => {
    store.connectSketchWire(railInfo(railId), layerInfo(trk, 'bypass'));
    const reads = store.trackById(trk)!.reads ?? [];
    expect(reads.length).toBe(1);
    expect(reads[0].targetField).toBe('bypass');
  });

  it('a same-track mod OUTPUT dropped on the layer becomes an own-layer clip wire', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'output', true), layerInfo(trk));
    const wires = store.trackById(trk)!.clips[0].sketch.wires ?? [];
    expect(wires.length).toBe(1);
    expect(wires[0].src).toEqual({ instanceKey: devId, field: 'output' });
    expect(wires[0].dest).toEqual({ instanceKey: LAYER_TARGET_ID, field: 'opacity' });
  });

  it('cross-track direct layer wires are rejected (rails are the mechanism)', () => {
    const other = store.addTrack();
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'output', true), layerInfo(other));
    expect(store.trackById(trk)!.clips[0].sketch.wires ?? []).toHaveLength(0);
    expect(store.trackById(other)!.reads ?? []).toHaveLength(0);
  });

  it('own-layer BYPASS wires are rejected (self-killing)', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'output', true), layerInfo(trk, 'bypass'));
    expect(store.trackById(trk)!.clips[0].sketch.wires ?? []).toHaveLength(0);
  });

  it('an INPUT field dropped on the layer is rejected (source must be an output)', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'gain', false), layerInfo(trk));
    expect(store.trackById(trk)!.clips[0].sketch.wires ?? []).toHaveLength(0);
  });

  it('selectAutoField labels __layer__ and reserved device keys', () => {
    store.selectAutoField(`track/${trk}`, LAYER_TARGET_ID, 'opacity');
    expect(store.autoField(`track/${trk}`)!.label).toBe('Layer · Opacity');
    store.selectAutoField(`track/${trk}`, LAYER_TARGET_ID, 'bypass');
    expect(store.autoField(`track/${trk}`)!.label).toBe('Layer · Bypass');
    store.selectAutoField(`clip/${trk}/${clipId}`, devId, '__opacity__');
    expect(store.autoField(`clip/${trk}/${clipId}`)!.label).toMatch(/· Opacity$/);
  });

  it('ensureSelectedTrackLane creates a lane with the __layer__ sentinel', () => {
    store.selectAutoField(`track/${trk}`, LAYER_TARGET_ID, 'opacity');
    const laneId = store.ensureSelectedTrackLane(trk);
    const lane = store.trackById(trk)!.automation.find((l) => l.id === laneId)!;
    expect(lane.targetDeviceId).toBe(LAYER_TARGET_ID);
    expect(lane.targetField).toBe('opacity');
    expect(lane.label).toBe('Layer · Opacity');
  });
});
