import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';
import { compositionLengthBeats } from '../model/composition';

/**
 * Track structural ops + selection/time-box semantics: add / delete / reorder
 * tracks, cross-track clip moves, and the "selecting a track selects a full-track
 * time box (and shows the track as selected)" behaviour.
 */
describe('track structural ops', () => {
  const plainTracks = () => store.composition.tracks.filter((t) => t.kind === 'track');

  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
  });

  it('addTrack appends a plain track and selects it', () => {
    const before = store.composition.tracks.length;
    const id = store.addTrack();
    expect(store.composition.tracks.length).toBe(before + 1);
    expect(store.trackById(id)?.kind).toBe('track');
    expect(store.isSelected(paths.track(id))).toBe(true);
  });

  it('addTrack starts fully opaque (level 1, not the mixer default 0.85)', () => {
    const id = store.addTrack();
    expect(store.trackById(id)?.level).toBe(1);
  });

  it('setTrackBlendMode sets the track blend index', () => {
    const id = store.addTrack();
    store.setTrackBlendMode(id, 3); // Screen
    expect(store.trackById(id)?.blendMode).toBe(3);
  });

  it('selecting a return (rail) track selects all time on it (unified caret)', () => {
    const id = store.addReturn();
    store.select(paths.track(id));
    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelTrackIds).toContain(id);
    expect(store.isTrackShownSelected(id)).toBe(true);
  });

  it('a return track participates in the caret span (caretTrackIds)', () => {
    const id = store.addReturn();
    store.setCaret({ anchorBeat: 0, anchorTrackId: id, headBeat: 4, headTrackId: id });
    expect(store.caretTrackIds).toContain(id);
  });

  it('track blend mode drives the composite layer (track wins over clip)', () => {
    const id = store.addTrack();
    store.addVideoClip(id, 0, { sourceKey: 'k', url: 'blob:x', frameCount: 30, fps: 30, label: 'v' }, 4);
    store.setTrackBlendMode(id, 5); // Darken
    const layer = store.compositeLayersAtBeat(1).find((l) => l.track.id === id);
    expect(layer?.blendMode).toBe(5);
  });

  it('addTrack(afterId) inserts immediately after the given track', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    const ids = store.composition.tracks.map((t) => t.id);
    expect(ids.indexOf(b)).toBe(ids.indexOf(a) + 1);
  });

  it('addTrackAfterSelection inserts after the last shown-selected track', () => {
    const a = store.addTrack();
    store.select(paths.track(a)); // focuses a + sets its time box
    const created = store.addTrackAfterSelection();
    const ids = store.composition.tracks.map((t) => t.id);
    expect(ids.indexOf(created)).toBe(ids.indexOf(a) + 1);
  });

  it('selecting a track sets a full-track time box and shows it selected', () => {
    const a = store.addTrack();
    store.select(paths.track(a));
    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelStart).toBe(0);
    expect(store.timeSelEnd).toBe(compositionLengthBeats(store.composition));
    expect(store.timeSelTrackIds).toEqual([a]);
    expect(store.isTrackShownSelected(a)).toBe(true);
  });

  it('a time region shows its covered tracks as selected without focusing them', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.setTimeSelection(0, 8, [a, b]);
    expect(store.isTrackShownSelected(a)).toBe(true);
    expect(store.isTrackShownSelected(b)).toBe(true);
    // Not focused → inspector primary path is unaffected.
    expect(store.isSelected(paths.track(a))).toBe(false);
  });

  it('deleteSelectedTracks removes the focused track but never the main bus', () => {
    const a = store.addTrack();
    store.select(paths.track(a));
    store.deleteSelectedTracks();
    expect(store.trackById(a)).toBeUndefined();

    const bus = store.mainBusTrack!;
    store.clearSelection();
    store.selection.add(paths.track(bus.id));
    (store as any).primaryPath = paths.track(bus.id);
    store.deleteSelectedTracks();
    expect(store.trackById(bus.id)).toBeDefined(); // bus survives
  });

  it('deleting a nested group reparents its children upward', () => {
    const bus = store.mainBusTrack!;
    // A nested group (kind group, non-null parent) is deletable, unlike the bus.
    const group = store.addTrack();
    const g = store.composition.tracks.find((t) => t.id === group)!;
    g.kind = 'group';
    g.parentId = bus.id;
    const child = store.addTrack();
    store.composition.tracks.find((t) => t.id === child)!.parentId = group;
    store.clearSelection();
    store.selection.add(paths.track(group));
    (store as any).primaryPath = paths.track(group);
    store.deleteSelectedTracks();
    expect(store.trackById(group)).toBeUndefined();
    expect(store.trackById(child)?.parentId).toBe(bus.id); // reparented to group's parent
  });

  it('moveTrack reorders among non-bus tracks', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    // b currently right after a; move a to before nothing (end) → a after b.
    store.moveTrack(a, null);
    const order = store.composition.tracks.filter((t) => !store.isMainBus(t)).map((t) => t.id);
    expect(order.indexOf(a)).toBeGreaterThan(order.indexOf(b));
  });

  it('moveTrack refuses to move the main bus', () => {
    const bus = store.mainBusTrack!;
    const before = store.composition.tracks.map((t) => t.id).join(',');
    store.moveTrack(bus.id, null);
    expect(store.composition.tracks.map((t) => t.id).join(',')).toBe(before);
  });

  it('addGroup with no selection creates a group containing one empty track', () => {
    store.clearSelection();
    const gid = store.addGroup();
    const g = store.trackById(gid);
    expect(g?.kind).toBe('group');
    expect(g?.parentId).toBeNull();
    const children = store.composition.tracks.filter((t) => t.parentId === gid);
    expect(children.length).toBe(1);
    expect(children[0].kind).toBe('track');
    expect(children[0].clips.length).toBe(0);
    expect(store.isSelected(paths.track(gid))).toBe(true);
  });

  it('addGroup with selected tracks moves them under the group, contiguous below it', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.clearSelection();
    store.selection.add(paths.track(a));
    store.selection.add(paths.track(b));
    (store as any).primaryPath = paths.track(a);
    const gid = store.addGroup();
    expect(store.trackById(a)?.parentId).toBe(gid);
    expect(store.trackById(b)?.parentId).toBe(gid);
    // The group is placed immediately above its children (so the display nests).
    const ids = store.composition.tracks.map((t) => t.id);
    expect(ids.indexOf(a)).toBe(ids.indexOf(gid) + 1);
    expect(ids.indexOf(b)).toBe(ids.indexOf(gid) + 2);
  });

  it('addGroup never grabs the main bus or rail/return tracks', () => {
    const t = store.addTrack();
    const r = store.addReturn();
    store.clearSelection();
    store.selection.add(paths.track(t));
    store.selection.add(paths.track(r));
    (store as any).primaryPath = paths.track(t);
    const gid = store.addGroup();
    expect(store.trackById(t)?.parentId).toBe(gid);
    expect(store.trackById(r)?.parentId).toBeNull(); // a return is not grouped
  });

  it('addGroup is a single undoable action', () => {
    store.clearSelection();
    const before = store.composition.tracks.length;
    store.addGroup();
    expect(store.composition.tracks.length).toBe(before + 2); // group + empty child
    store.undo();
    expect(store.composition.tracks.length).toBe(before);
  });
});

describe('cross-track clip moves', () => {
  it('moveClipToTrack relocates a clip to an eligible track', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    const path = store.createEmptyClip(a, 4, 8)!;
    const clipId = path.split('/')[2];
    store.moveClipToTrack(a, clipId, b, 12);
    expect(store.trackById(a)!.clips.find((c) => c.id === clipId)).toBeUndefined();
    const moved = store.trackById(b)!.clips.find((c) => c.id === clipId);
    expect(moved).toBeDefined();
    expect(moved!.startBeat).toBe(12);
  });

  it('an ineligible destination keeps the clip on its source track', () => {
    const a = store.addTrack();
    const rail = store.composition.tracks.find((t) => t.kind === 'rail');
    const path = store.createEmptyClip(a, 4, 8)!;
    const clipId = path.split('/')[2];
    store.moveClipToTrack(a, clipId, rail ? rail.id : 'nope', 12);
    const stay = store.trackById(a)!.clips.find((c) => c.id === clipId);
    expect(stay).toBeDefined();
    expect(stay!.startBeat).toBe(12); // still repositioned, just not relocated
  });
});
