import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';

/**
 * Automation nodes are pinned to BEATS, not percentage-of-clip: resizing a clip
 * (clip-length mode) rescales interior nodes so their clip-beat is preserved;
 * the 0/1 endpoints track the clip boundaries. Loop mode is unaffected by a clip
 * resize (its span is the loop, not the clip).
 */
describe('automation beat-pinning on clip resize', () => {
  let t1: string;
  let clipId: string;
  let laneId: string;
  beforeEach(() => {
    store.clearSelection();
    store.setClipAutoTiming('clip');
    t1 = store.addTrack();
    clipId = store.createEmptyClip(t1, 0, 16)!.split('/')[2]; // 4 bars
    laneId = store.ensureClipAutomationLane(t1, clipId);
    // A node at 50% (bar 2) between the pinned endpoints.
    store.setAutomationPoints(laneId, [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.9 }, { x: 1, y: 0.5 }], 'seed');
  });

  const lane = () => store.trackById(t1)!.clips.find((c) => c.id === clipId)!.automation[0];

  it('extending the clip holds the node at its beat (50% → 25%)', () => {
    store.resizeClip(t1, clipId, 0, 32); // 4 bars → 8 bars
    const pts = lane().points;
    expect(pts[0].x).toBe(0); // endpoints unchanged (clip boundaries)
    expect(pts[2].x).toBe(1);
    expect(pts[1].x).toBeCloseTo(0.25); // bar 2 of 8 = 25%
  });

  it('shrinking pushes an out-of-range node past 1 and leaves it (no clamp)', () => {
    store.resizeClip(t1, clipId, 0, 8); // 4 bars → 2 bars; bar 2 is now the end
    const interior = lane().points[1];
    expect(interior.x).toBeCloseTo(1.0); // bar 2 of 2 = the end
    // A node at bar 3 (x=0.75) would land at 1.5 — out of range, left as-is.
    store.setAutomationPoints(laneId, [{ x: 0, y: 0.5 }, { x: 0.75, y: 0.9 }, { x: 1, y: 0.5 }], 's2');
    store.resizeClip(t1, clipId, 0, 4); // 2 bars → 1 bar
    expect(lane().points[1].x).toBeCloseTo(1.5); // 0.75 * (8/4) = 1.5, not clamped
  });

  it('loop mode: a clip resize does NOT rescale automation', () => {
    store.setClipAutoTiming('loop');
    store.resizeClip(t1, clipId, 0, 32);
    expect(lane().points[1].x).toBe(0.5); // untouched (span = loop, not clip)
  });
});
