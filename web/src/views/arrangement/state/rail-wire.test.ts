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

  it('deleteWire removes a rail export and clears its selection + popup', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'level', true), railInfo(railId));
    const expId = store.trackById(trk)!.clips[0].exports[0].id;
    const wireId = 'w:' + expId;
    store.selectWire(wireId, `clip/${trk}/${clipId}`, {});
    store.openTapPopup({ wireId, x: 0, y: 0, label: 'x' });
    expect(store.deleteSelectedWire()).toBe(true);
    expect(store.trackById(trk)!.clips[0].exports.length).toBe(0);
    expect(store.selectedWireId).toBeNull();
    expect(store.tapPopup).toBeNull();
  });

  it('deleteWire removes a rail read by r: id', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'gain', false), railInfo(railId));
    const readId = store.trackById(trk)!.clips[0].reads![0].id;
    store.deleteWire('r:' + readId);
    expect(store.trackById(trk)!.clips[0].reads!.length).toBe(0);
  });

  it('dismissPopups closes the rail popup (click-away)', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'level', true), railInfo(railId));
    const wireId = 'w:' + store.trackById(trk)!.clips[0].exports[0].id;
    store.selectWire(wireId, `clip/${trk}/${clipId}`, {});
    store.openTapPopup({ wireId, x: 0, y: 0, label: 'x' });
    store.dismissPopups();
    expect(store.selectedWireId).toBeNull();
    expect(store.tapPopup).toBeNull();
  });

  it('selecting a field dismisses an open rail popup (unified focus)', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'level', true), railInfo(railId));
    const wireId = 'w:' + store.trackById(trk)!.clips[0].exports[0].id;
    store.selectWire(wireId, `clip/${trk}/${clipId}`, {});
    store.openTapPopup({ wireId, x: 0, y: 0, label: 'x' });
    store.selectAutoField(`clip/${trk}/${clipId}`, devId, 'gain');
    expect(store.selectedWireId).toBeNull();
    expect(store.tapPopup).toBeNull();
  });

  it('focusing an in-sketch card supersedes an open rail popup', () => {
    store.connectSketchWire(fieldInfo(`clip/${trk}/${clipId}`, 'level', true), railInfo(railId));
    const wireId = 'w:' + store.trackById(trk)!.clips[0].exports[0].id;
    store.selectWire(wireId, `clip/${trk}/${clipId}`, {});
    store.openTapPopup({ wireId, x: 0, y: 0, label: 'x' });
    store.setChainFocus(`effect/clip/${trk}/${clipId}/0/0`);
    expect(store.selectedWireId).toBeNull();
    expect(store.tapPopup).toBeNull();
  });
});
