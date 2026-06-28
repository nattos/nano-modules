import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths, GROUP_INDENT } from './store';
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

  it('deleting a group deletes its whole subtree (contained tracks included)', () => {
    const group = store.addTrack();
    const g = store.composition.tracks.find((t) => t.id === group)!;
    g.kind = 'group';
    g.parentId = null;
    const child = store.addTrack();
    store.composition.tracks.find((t) => t.id === child)!.parentId = group;
    store.clearSelection();
    store.selection.add(paths.track(group));
    (store as any).primaryPath = paths.track(group);
    store.deleteSelectedTracks();
    expect(store.trackById(group)).toBeUndefined();
    expect(store.trackById(child)).toBeUndefined(); // the contained track is deleted too
  });

  it('ungroup dissolves a group and lifts its children to the parent level', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.clearSelection();
    store.selection.add(paths.track(a));
    store.selection.add(paths.track(b));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a, b], top level
    store.ungroup(g);
    expect(store.trackById(g)).toBeUndefined();
    expect(store.trackById(a)?.parentId).toBeNull();
    expect(store.trackById(b)?.parentId).toBeNull();
  });

  it('selecting a group scopes the time box across all of its contained tracks', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.clearSelection();
    store.selection.add(paths.track(a));
    store.selection.add(paths.track(b));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a, b]
    store.select(paths.track(g));
    expect(store.hasTimeSelection).toBe(true);
    const scope = store.timeSelTrackIds;
    expect(scope).toContain(a); // both children are in the time scope...
    expect(scope).toContain(b);
    expect(store.isTrackShownSelected(a)).toBe(true); // ...and render as selected
    expect(store.isTrackShownSelected(b)).toBe(true);
  });

  it('selectedSingleGroupId reports only a lone selected group', () => {
    const a = store.addTrack();
    store.clearSelection();
    store.selection.add(paths.track(a));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // addGroup selects the group
    expect(store.selectedSingleGroupId).toBe(g);
    store.select(paths.track(a)); // select a child track instead
    expect(store.selectedSingleGroupId).toBeNull();
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

  it('selecting a track sets an all-time box WITHOUT moving the play-from caret', () => {
    const t = store.addTrack();
    // Put the play-from caret at beat 12 (as a grid click would).
    store.setCaret({ anchorBeat: 12, anchorTrackId: t, headBeat: 12, headTrackId: t });
    expect(store.playFromBeat).toBe(12);
    expect(store.hasTimeSelection).toBe(false);
    // Selecting the track scopes a full-time box but must NOT yank play-from / playhead.
    store.select(paths.track(t));
    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelStart).toBe(0);
    expect(store.timeSelEnd).toBeGreaterThan(0);
    expect(store.playFromBeat).toBe(12); // marker stays put (the regression)
    expect(store.positionBeat).toBe(12); // playhead stays put
    // A fresh caret gesture takes the box back to riding the caret (zero-width here).
    store.setCaret({ anchorBeat: 4, anchorTrackId: t, headBeat: 4, headTrackId: t });
    expect(store.hasTimeSelection).toBe(false);
    expect(store.playFromBeat).toBe(4);
  });

  it('the main bus is a caret row (selectable), and selecting it scopes globally', () => {
    store.addTrack();
    const bus = store.mainBusTrack!;
    // It participates in the caret row axis (a group at heart) — not excluded.
    expect(store.caretRows.some((r) => r.trackId === bus.id && r.laneId === '')).toBe(true);
    // Selecting it resolves to the GLOBAL scope (it has no descendant tracks, so the
    // group-expansion yields the empty/all-tracks span — "everything sums here").
    store.select(paths.track(bus.id));
    expect(store.hasTimeSelection).toBe(true);
    expect(store.timeSelTrackIds).toEqual([]); // [] = global (all plain tracks)
    expect(store.primaryPath).toBe(paths.track(bus.id)); // shows in the inspector
  });

  it('the main bus can host automation lanes (its FX bus is automatable)', () => {
    const bus = store.mainBusTrack!;
    bus.sketch.devices.push({ id: 'mbfx', moduleType: 'color.invert', name: 'invert', capabilities: [], state: {} } as any);
    if (!store.automationMode) store.toggleAutomationMode();
    store.selectAutoField(paths.track(bus.id), 'mbfx', 'amount');
    const laneId = store.ensureSelectedTrackLane(bus.id);
    expect(laneId).toBeTruthy();
    // The lane is a navigable caret row under the bus.
    expect(store.caretRows.some((r) => r.trackId === bus.id && r.laneId === laneId)).toBe(true);
    if (store.automationMode) store.toggleAutomationMode();
  });

  it('selecting a param that already has a lane keeps the lane as its own row (no overlay hoist)', () => {
    const t = store.addTrack();
    if (!store.automationMode) store.toggleAutomationMode();
    store.selectAutoField(paths.track(t), 'devX', 'amount');
    const laneId = store.ensureSelectedTrackLane(t);
    // Even with the field selected, the existing lane is NEVER hoisted to the clip
    // row (overlayLaneId === '') — so it stays visible as a standalone caret row.
    expect(store.overlayLaneId(t)).toBe('');
    expect(store.caretRows.some((r) => r.trackId === t && r.laneId === laneId)).toBe(true);
    // The clip row stays a clip row (laneId ''), not the lane's overlay.
    expect(store.caretRows.some((r) => r.trackId === t && r.laneId === '')).toBe(true);
    if (store.automationMode) store.toggleAutomationMode();
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

  it('ancestorGroupAtDepth resolves the group whose gutter line sits in a column', () => {
    // Build a depth-2 nest: outer group ▸ inner group ▸ leaf.
    const outer = store.addTrack();
    const og = store.trackById(outer)!; og.kind = 'group'; og.parentId = null;
    const inner = store.addTrack();
    const ig = store.trackById(inner)!; ig.kind = 'group'; ig.parentId = outer;
    const leaf = store.addTrack();
    store.trackById(leaf)!.parentId = inner;

    expect(store.trackDepth(store.trackById(leaf)!)).toBe(2);
    expect(store.ancestorGroupAtDepth(leaf, 0)).toBe(outer); // outer ancestor in col 0
    expect(store.ancestorGroupAtDepth(leaf, 1)).toBe(inner); // inner ancestor in col 1
    expect(store.ancestorGroupAtDepth(leaf, 2)).toBeNull();  // a leaf has no own column
    expect(store.ancestorGroupAtDepth(inner, 1)).toBe(inner); // a group resolves itself
    // A depth-2 nest needs at least two gutter columns; width tracks the columns.
    expect(store.groupGutterColumns).toBeGreaterThanOrEqual(2);
    expect(store.groupGutterWidth).toBe(store.groupGutterColumns * GROUP_INDENT);
  });

  it('headerWidth = resizable base + group gutter (faders keep a constant width)', () => {
    const gutter = store.groupGutterWidth;
    store.setHeaderWidth(250 + gutter); // drag the column edge; base resolves to 250
    expect(store.headerWidth).toBe(250 + gutter);
    store.setHeaderWidth(50 + gutter); // base clamps to its 120 minimum
    expect(store.headerWidth).toBe(120 + gutter);
  });

  /** Non-bus tracks in array order (= composite/display order). */
  const order = () => store.composition.tracks.filter((t) => !store.isMainBus(t)).map((t) => t.id);

  it('a group and its children stay contiguous after a disruptive reorder', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.clearSelection();
    store.selection.add(paths.track(a));
    store.selection.add(paths.track(b));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a, b]
    const outside = store.addTrack();
    // Try to wedge `outside` between the group and its first child — must not split it.
    store.moveTrack(outside, a);
    const ids = order();
    const gi = ids.indexOf(g);
    expect(ids[gi + 1]).toBe(a); // children remain immediately under the group
    expect(ids[gi + 2]).toBe(b);
  });

  it('moveTrackInto drops a track into a group as its last child (contiguous)', () => {
    const a = store.addTrack();
    store.clearSelection();
    store.selection.add(paths.track(a));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a]
    const x = store.addTrack(); // top level
    store.moveTrackInto(x, g, null); // into g, append
    expect(store.trackById(x)?.parentId).toBe(g);
    const ids = order();
    expect(ids.indexOf(x)).toBe(ids.indexOf(g) + 2); // g, a, x
  });

  it('moveTrackInto pops a track out of a group to top level', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.clearSelection();
    store.selection.add(paths.track(a));
    store.selection.add(paths.track(b));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a, b]
    store.moveTrackInto(b, null, null); // out to top level
    expect(store.trackById(b)?.parentId).toBeNull();
    expect(store.trackById(a)?.parentId).toBe(g); // a stays in the group
  });

  it('addTrackAfterSelection creates inside a selected group', () => {
    const a = store.addTrack();
    store.clearSelection();
    store.selection.add(paths.track(a));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // addGroup leaves the group selected
    const created = store.addTrackAfterSelection();
    expect(store.trackById(created)?.parentId).toBe(g);
  });

  it('addTrackAfterSelection creates a sibling inside the group when a child is selected', () => {
    const a = store.addTrack();
    store.clearSelection();
    store.selection.add(paths.track(a));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a]
    store.select(paths.track(a)); // select the child
    const created = store.addTrackAfterSelection();
    expect(store.trackById(created)?.parentId).toBe(g); // lands in the same group
  });

  it('addTrackAfterSelection appends a top-level track when nothing is selected', () => {
    store.clearSelection();
    const created = store.addTrackAfterSelection();
    expect(store.trackById(created)?.parentId).toBeNull();
  });

  it('addTrack normalizes so a stray insert never splits a group', () => {
    const a = store.addTrack();
    const b = store.addTrack(a);
    store.clearSelection();
    store.selection.add(paths.track(a));
    store.selection.add(paths.track(b));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a, b]
    // A plain top-level addTrack inserted mid-array must not wedge between a and b.
    const x = store.addTrack(a); // afterTrackId = a (inside the group's span), parent null
    expect(store.trackById(x)?.parentId).toBeNull();
    const ids = order();
    const gi = ids.indexOf(g);
    expect(ids[gi + 1]).toBe(a);
    expect(ids[gi + 2]).toBe(b); // group stays contiguous; x is pushed out
  });

  it('moveTrackInto refuses to drop a group into its own subtree (no cycles)', () => {
    const a = store.addTrack();
    store.clearSelection();
    store.selection.add(paths.track(a));
    (store as any).primaryPath = paths.track(a);
    const g = store.addGroup(); // g ▸ [a]
    store.moveTrackInto(g, a, null); // put g inside its child a → rejected
    expect(store.trackById(g)?.parentId).toBeNull();
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
