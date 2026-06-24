import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';

/** Automation copy/paste: every row is an envelope, so a region's nodes copy
 *  from one lane and paste onto another (by row offset from the caret head). */
describe('automation copy/paste', () => {
  let t1: string;
  let t2: string;
  let l1: string;
  let l2: string;
  const laneOf = (id: string) => store.composition.tracks.flatMap((t) => t.automation).find((l) => l.id === id)!;

  beforeEach(() => {
    if (!store.automationMode) store.toggleAutomationMode();
    t1 = store.addTrack();
    t2 = store.addTrack();
    l1 = store.ensureTrackAutomationLane(t1);
    l2 = store.ensureTrackAutomationLane(t2);
    store.setAutomationPoints(l1, [{ x: 0, y: 0.5 }, { x: 0.3, y: 0.9 }, { x: 1, y: 0.5 }], 's1');
    store.setAutomationPoints(l2, [{ x: 0, y: 0.2 }, { x: 1, y: 0.2 }], 's2');
  });

  it('copies a region from one lane and pastes it onto another at the head', () => {
    // Caret = a region [0.2,0.5] on lane 1.
    store.setCaret({ anchorBeat: 0.2 * 32, anchorTrackId: t1, anchorLaneId: l1, headBeat: 0.5 * 32, headTrackId: t1, headLaneId: l1 });
    expect(store.caretLaneId).toBe(l1);
    expect(store.copyAutomation(0.2, 0.5)).toBe(true);
    expect(store.hasAutoClipboard).toBe(true);

    // Move the caret to lane 2 @ x=0.6, paste.
    store.setCaret({ anchorBeat: 0.6 * 32, anchorTrackId: t2, anchorLaneId: l2, headBeat: 0.6 * 32, headTrackId: t2, headLaneId: l2 });
    store.pasteAutomation(0.6);

    // l1's node at x=0.3 (rel 0.1) lands at 0.6 + 0.1 = 0.7.
    const pts = laneOf(l2).points;
    expect(pts.some((p) => Math.abs(p.x - 0.7) < 1e-6 && Math.abs(p.y - 0.9) < 1e-6)).toBe(true);
    // The source lane is untouched by copy.
    expect(laneOf(l1).points.length).toBe(3);
  });

  it('cut removes the region from the source after copying', () => {
    store.setCaret({ anchorBeat: 0.2 * 32, anchorTrackId: t1, anchorLaneId: l1, headBeat: 0.5 * 32, headTrackId: t1, headLaneId: l1 });
    store.cutAutomation(0.2, 0.5);
    // The x=0.3 node is gone; the 0/1 endpoints remain.
    const pts = laneOf(l1).points;
    expect(pts.some((p) => Math.abs(p.x - 0.3) < 1e-6)).toBe(false);
    expect(pts.length).toBe(2);
    expect(store.hasAutoClipboard).toBe(true);
  });

  it('copy needs a real region (zero width → nothing)', () => {
    store.setCaret({ anchorBeat: 0.3 * 32, anchorTrackId: t1, anchorLaneId: l1, headBeat: 0.3 * 32, headTrackId: t1, headLaneId: l1 });
    expect(store.copyAutomation(0.3, 0.3)).toBe(false);
  });
});
