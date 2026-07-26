import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from './store';
import { seedTestPlugins } from '../engine/test-plugins';

/**
 * The cheap-edit (drag) fast path: drag-coalesced mutations must NOT bump
 * docRev per frame (that shipped + re-parsed the whole document 60×/s) —
 * instead they queue field-level CompCheapOps the bridge forwards, and a
 * debounced reconcile (or endGesture) ships the canonical document ONCE.
 */
describe('comp cheap ops (drag fast path)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    while (store.canUndo) store.undo();
    seedTestPlugins();
    store.pendingCompOps.length = 0;
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const mkClipWithDevice = () => {
    const trk = store.addTrack();
    const path = store.createEmptyClip(trk, 0, 8)!;
    const clipId = path.split('/')[2];
    store.addClipDeviceType(trk, clipId, 'source.solid_color');
    const devId = store.trackById(trk)!.clips[0].sketch.devices[0].id;
    return { trk, clipId, devId };
  };

  it('a clip param drag queues param ops without bumping docRev; the debounce reconciles once', () => {
    const { trk, clipId, devId } = mkClipWithDevice();
    const rev = store.docRev;
    // A 5-frame drag burst.
    for (let i = 1; i <= 5; i++) {
      store.setClipDeviceField(trk, clipId, devId, 'color', [i / 5, 0, 0]);
    }
    expect(store.docRev).toBe(rev); // no whole-doc ships during the drag
    expect(store.pendingCompOps.length).toBe(5);
    expect(store.pendingCompOps[4]).toEqual({
      op: 'param', ownerId: clipId, deviceId: devId, field: 'color',
      valueJson: JSON.stringify([1, 0, 0]),
    });
    // The store document itself is canonical throughout.
    expect(store.trackById(trk)!.clips[0].sketch.devices[0].state?.color).toEqual([1, 0, 0]);
    // Trailing debounce ships the doc exactly once.
    vi.advanceTimersByTime(350);
    expect(store.docRev).toBe(rev + 1);
    expect(store.pendingCompOps.length).toBe(0);
    // ...and only once (no further creep).
    vi.advanceTimersByTime(1000);
    expect(store.docRev).toBe(rev + 1);
  });

  it('the whole drag coalesces into ONE undo entry that restores the pre-drag value', () => {
    const { trk, clipId, devId } = mkClipWithDevice();
    store.setClipDeviceField(trk, clipId, devId, 'scale', 0.1);
    // Age past the 500ms coalesce window (fake timers drive Date.now too), so
    // the next drag starts a FRESH undo entry.
    vi.advanceTimersByTime(600);
    for (let i = 1; i <= 4; i++) store.setClipDeviceField(trk, clipId, devId, 'scale', 0.1 + i / 10);
    vi.advanceTimersByTime(350);
    expect(store.trackById(trk)!.clips[0].sketch.devices[0].state?.scale).toBeCloseTo(0.5);
    const rev = store.docRev;
    store.undo(); // ONE undo unwinds the whole 4-frame drag
    expect(store.trackById(trk)!.clips[0].sketch.devices[0].state?.scale).toBeCloseTo(0.1);
    expect(store.docRev).toBe(rev + 1); // undo ships the doc (reconcile path)
  });

  it('track device fields address the TRACK as owner', () => {
    const trk = store.addTrack();
    store.insertTrackDeviceAt(trk, 0, 'mod.source.lfo');
    const devId = store.trackById(trk)!.sketch.devices[0].id;
    store.pendingCompOps.length = 0;
    const rev = store.docRev;
    store.setTrackDeviceField(trk, devId, 'rate', 0.7);
    expect(store.docRev).toBe(rev);
    expect(store.pendingCompOps).toEqual([
      { op: 'param', ownerId: trk, deviceId: devId, field: 'rate', valueJson: '0.7' },
    ]);
  });

  it('the track fader rides the trackLevel op', () => {
    const trk = store.addTrack();
    store.pendingCompOps.length = 0;
    const rev = store.docRev;
    store.setTrackLevel(trk, 0.4);
    expect(store.docRev).toBe(rev);
    expect(store.pendingCompOps).toEqual([{ op: 'trackLevel', trackId: trk, level: 0.4 }]);
  });

  it('source-transform drags carry the ABSOLUTE resolved transform', () => {
    const trk = store.addTrack();
    store.addVideoClip(trk, 0, { sourceKey: 'k', url: 'blob:x', frameCount: 30, fps: 30, label: 'v' }, 8);
    const clipId = store.trackById(trk)!.clips[0].id;
    store.pendingCompOps.length = 0;
    const rev = store.docRev;
    store.setClipSourceTransform(trk, clipId, { scale: 0.5 });
    expect(store.docRev).toBe(rev);
    expect(store.pendingCompOps.length).toBe(1);
    const op = store.pendingCompOps[0];
    expect(op.op).toBe('sourceTransform');
    expect(op.ownerId).toBe(clipId);
    const t = JSON.parse(op.valueJson!);
    expect(t.scale).toBe(0.5);
    expect(t.anchorX).toBe(0.5); // defaults resolved into the absolute payload
    // A second drag frame patches over the RESOLVED current, not the base.
    store.setClipSourceTransform(trk, clipId, { rotation: 90 });
    const t2 = JSON.parse(store.pendingCompOps[1].valueJson!);
    expect(t2.scale).toBe(0.5);
    expect(t2.rotation).toBe(90);
  });

  it('a transform edit on a sourceless clip is a no-op (no op, no history)', () => {
    const trk = store.addTrack();
    const path = store.createEmptyClip(trk, 0, 8)!;
    const clipId = path.split('/')[2];
    store.pendingCompOps.length = 0;
    const canUndoBefore = store.canUndo;
    store.setClipSourceTransform(trk, clipId, { scale: 0.5 });
    expect(store.pendingCompOps.length).toBe(0);
    expect(store.canUndo).toBe(canUndoBefore);
  });

  it('coalesced lane drags ride lanePoints (flat x,y,bend triples + owner)', () => {
    const { trk, clipId } = mkClipWithDevice();
    // Author a clip lane directly (test-only shortcut), then drag its points.
    const clip = store.trackById(trk)!.clips[0];
    clip.automation.push({ id: 'lane-x', targetDeviceId: clip.sketch.devices[0].id,
      targetField: 'scale', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } as any);
    store.pendingCompOps.length = 0;
    const rev = store.docRev;
    store.setAutomationPoints('lane-x', [{ x: 0, y: 0.5 }, { x: 1, y: 1, bend: 0.2 }], 'lanedrag:lane-x');
    expect(store.docRev).toBe(rev);
    expect(store.pendingCompOps).toEqual([{
      op: 'lanePoints', ownerId: clipId, laneId: 'lane-x',
      points: [0, 0.5, 0, 1, 1, 0.2],
    }]);
    // A NON-coalesced (single-shot) lane edit takes the plain docRev path,
    // and the full-doc ship supersedes (clears) the queued ops.
    store.setAutomationPoints('lane-x', [{ x: 0, y: 1 }]);
    expect(store.docRev).toBe(rev + 1);
    expect(store.pendingCompOps.length).toBe(0);
  });

  it('endGesture flushes the reconcile immediately', () => {
    const { trk, clipId, devId } = mkClipWithDevice();
    const rev = store.docRev;
    store.beginGesture();
    store.setClipDeviceField(trk, clipId, devId, 'scale', 0.9);
    expect(store.docRev).toBe(rev);
    store.endGesture();
    expect(store.docRev).toBe(rev + 1); // no 300ms wait
    expect(store.pendingCompOps.length).toBe(0);
  });

  it('a structural edit mid-drag ships the doc and supersedes queued ops', () => {
    const { trk, clipId, devId } = mkClipWithDevice();
    store.setClipDeviceField(trk, clipId, devId, 'scale', 0.3);
    expect(store.pendingCompOps.length).toBe(1);
    const rev = store.docRev;
    store.addTrack(); // structural → whole doc ships
    expect(store.docRev).toBeGreaterThan(rev);
    expect(store.pendingCompOps.length).toBe(0);
    // ...and the trailing debounce does NOT double-ship afterwards.
    vi.advanceTimersByTime(1000);
    expect(store.docRev).toBe(rev + 1);
  });

  it('multi-clip param edits fan out one op per clip', () => {
    const a = mkClipWithDevice();
    const b = mkClipWithDevice();
    store.pendingCompOps.length = 0;
    store.setClipsDeviceField(
      [
        { trackId: a.trk, clipId: a.clipId, deviceId: a.devId },
        { trackId: b.trk, clipId: b.clipId, deviceId: b.devId },
      ],
      'scale', 0.6,
    );
    expect(store.pendingCompOps.map((o) => o.ownerId)).toEqual([a.clipId, b.clipId]);
    expect(store.pendingCompOps.every((o) => o.op === 'param' && o.valueJson === '0.6')).toBe(true);
  });
});
