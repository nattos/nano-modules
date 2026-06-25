import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { FieldConnectInfo } from '../../../sketch-types';

/**
 * Wiring a clip device field to a return rail: an OUTPUT field exports to the rail,
 * an INPUT field reads from it. Routed through connectSketchWire (the same entry the
 * WireConnect gesture calls).
 */
describe('field ⇄ rail wiring', () => {
  const railInfo = (railId: string): FieldConnectInfo =>
    ({ sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0, schemaDef: null, railId });
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

  it('an OUTPUT field dropped on a rail creates a rail export', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'level', true), railInfo(railId));
    const exp = store.trackById(trk)!.clips[0].exports;
    expect(exp.some((e) => e.railId === railId && e.sourceDeviceId === devId && e.sourceField === 'level')).toBe(true);
  });

  it('an INPUT field dropped on a rail creates a rail read', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'gain', false), railInfo(railId));
    const reads = store.trackById(trk)!.clips[0].reads ?? [];
    expect(reads.some((r) => r.railId === railId && r.targetDeviceId === devId && r.targetField === 'gain')).toBe(true);
  });

  it('routes regardless of endpoint order (rail first)', () => {
    store.connectSketchWire(railInfo(railId), fieldInfo(`clip/${trk}/${clipId}`, 'out', true));
    expect(store.trackById(trk)!.clips[0].exports.some((e) => e.sourceField === 'out')).toBe(true);
  });

  it('the rail export shows up in railWriters (overlay arcs)', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'level', true), railInfo(railId));
    expect(store.railWriters(railId).some((w) => w.clip.id === clipId)).toBe(true);
  });

  it('replacing a read into the same field keeps just one', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'gain', false), railInfo(railId));
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'gain', false), railInfo(railId));
    const reads = (store.trackById(trk)!.clips[0].reads ?? []).filter((r) => r.targetField === 'gain');
    expect(reads.length).toBe(1);
  });
});
