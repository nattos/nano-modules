import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import { seedTestPlugins } from "../engine/test-plugins";
seedTestPlugins(); // offline registry: catalogEffect resolves source/effect roles

/**
 * Store-side automation point editing (Component F: editable automation).
 * Covers the lane-id locator (clip + track), {x,y,bend} normalization, the
 * per-gesture coalescing that makes a drag one undo, and create-on-demand.
 */
describe('arrangement automation editing', () => {
  let trackId: string;
  let clipId: string;

  beforeEach(() => {
    const track = store.composition.tracks.find((t) => t.kind === 'track')!;
    trackId = track.id;
    const path = store.createEmptyClip(trackId, 0, 8);
    clipId = path.split('/')[2];
    store.addClipDeviceType(trackId, clipId, 'color.hsl');
  });

  it('ensureClipAutomationLane creates a lane targeting the first device field', () => {
    const id = store.ensureClipAutomationLane(trackId, clipId);
    const lane = store.automationLane(id)!;
    expect(lane).toBeDefined();
    expect(lane.points.length).toBeGreaterThan(0);
    // color.hsl's first catalog field is hue_shift / 'Hue'.
    expect(lane.targetField).toBe('hue_shift');
    expect(lane.label).toContain('Hue');
    // Idempotent: a second call returns the SAME lane (no duplicate).
    expect(store.ensureClipAutomationLane(trackId, clipId)).toBe(id);
    expect(store.clipByPath(`clip/${trackId}/${clipId}`)!.clip.automation.length).toBe(1);
  });

  it('setAutomationPoints normalizes to {x,y,bend} (missing bend → 0)', () => {
    const id = store.ensureClipAutomationLane(trackId, clipId);
    store.setAutomationPoints(id, [
      { x: 0, y: 0.2, bend: 0.5 },
      { x: 1, y: 0.9 }, // no bend
    ]);
    const lane = store.automationLane(id)!;
    expect(lane.points).toEqual([
      { x: 0, y: 0.2, bend: 0.5 },
      { x: 1, y: 0.9, bend: 0 },
    ]);
  });

  it('a shared coalesceKey makes repeated edits ONE undo (a drag gesture)', () => {
    const id = store.ensureClipAutomationLane(trackId, clipId);
    const before = store.automationLane(id)!.points.map((p) => ({ ...p }));

    const key = `auto:${id}:1`;
    store.setAutomationPoints(id, [{ x: 0, y: 0.1 }, { x: 1, y: 0.1 }], key);
    store.setAutomationPoints(id, [{ x: 0, y: 0.7 }, { x: 1, y: 0.7 }], key);
    expect(store.automationLane(id)!.points[0].y).toBe(0.7);

    store.undo(); // one undo unwinds the whole coalesced gesture
    expect(store.automationLane(id)!.points).toEqual(before);
  });

  it('distinct coalesceKeys are separate undo entries', () => {
    const id = store.ensureClipAutomationLane(trackId, clipId);
    store.setAutomationPoints(id, [{ x: 0, y: 0.1 }, { x: 1, y: 0.1 }], `auto:${id}:a`);
    store.setAutomationPoints(id, [{ x: 0, y: 0.8 }, { x: 1, y: 0.8 }], `auto:${id}:b`);

    store.undo();
    expect(store.automationLane(id)!.points[0].y).toBe(0.1); // back to gesture A
  });

  it('ensureTrackAutomationLane + lane lookup spans track AND clip lanes', () => {
    const clipLaneId = store.ensureClipAutomationLane(trackId, clipId);
    const trackLaneId = store.ensureTrackAutomationLane(trackId);
    expect(trackLaneId).not.toBe(clipLaneId);
    // automationLane() finds both, proving the locator searches both scopes.
    expect(store.automationLane(clipLaneId)).toBeDefined();
    expect(store.automationLane(trackLaneId)).toBeDefined();
    // Editing the track lane doesn't touch the clip lane.
    store.setAutomationPoints(trackLaneId, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(store.automationLane(trackLaneId)!.points[1].y).toBe(1);
    expect(store.automationLane(clipLaneId)!.points[1].y).toBe(0.5);
  });
});
