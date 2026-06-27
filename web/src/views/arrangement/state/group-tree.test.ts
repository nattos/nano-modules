import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { Track } from '../model/composition';
import type { CompositeNode, CompositeGroupNode } from '../engine/clip-sketch';

/**
 * compositeTreeAtBeat — the hierarchical composite the group-effect compositor
 * consumes: groups become nodes whose children render under them, with own-level
 * opacity (NOT ancestor-multiplied; the recursion folds group opacity in via the
 * blend-up). Plus setGroupInput (the group's compositing input mode).
 */
const isGroup = (n: CompositeNode): n is CompositeGroupNode =>
  (n as CompositeGroupNode).type === 'group';

const engineClip = (trackId: string, start: number, len = 8) => {
  const path = store.createEmptyClip(trackId, start, len)!;
  const clipId = path.split('/')[2];
  store.addClipDeviceType(trackId, clipId, 'color.hsl');
  return clipId;
};

/** Wrap `trackId` in a NEW user group (not the main bus); returns the group id. */
const groupAround = (trackId: string): string => {
  store.setSelection([`track/${trackId}`]);
  return store.addGroup();
};

describe('compositeTreeAtBeat', () => {
  let tA: Track;
  let tB: Track;

  beforeEach(() => {
    while (store.composition.tracks.filter((t) => t.kind === 'track').length < 2) store.addTrack();
    // Drop any user groups left by a prior test; reset flags + flatten to roots.
    for (const g of store.composition.tracks.filter((t) => t.kind === 'group' && !store.isMainBus(t))) {
      for (const t of store.composition.tracks) if (t.parentId === g.id) t.parentId = null;
    }
    store.composition.tracks = store.composition.tracks.filter(
      (t) => !(t.kind === 'group' && !store.isMainBus(t)),
    );
    for (const t of store.composition.tracks) {
      t.soloed = false; t.bypassed = false; t.level = undefined; t.parentId = null; t.groupInput = undefined;
      if (t.kind === 'track') t.clips = []; // singleton store — clear prior tests' clips
    }
    const tracks = store.composition.tracks.filter((t) => t.kind === 'track');
    tA = tracks[0];
    tB = tracks[1];
    store.setSelection([]);
  });

  it('a top-level track is a clip leaf at the root (no main bus in the tree)', () => {
    engineClip(tA.id, 50);
    const tree = store.compositeTreeAtBeat(52);
    expect(tree.some((n) => !isGroup(n) && (n as any).track.id === tA.id)).toBe(true);
    // The main bus never appears as a content group.
    expect(tree.some((n) => isGroup(n) && store.isMainBus(n.group))).toBe(false);
  });

  it('a track inside a group nests under a group node; leaf opacity is the OWN level', () => {
    engineClip(tA.id, 50);
    const gid = groupAround(tA.id);
    store.setTrackLevel(gid, 0.5);
    store.setTrackLevel(tA.id, 0.5);
    const tree = store.compositeTreeAtBeat(52);
    const g = tree.find((n) => isGroup(n) && n.group.id === gid) as CompositeGroupNode;
    expect(g).toBeTruthy();
    expect(g.opacity).toBeCloseTo(0.5, 6); // group's OWN level
    const child = g.children.find((n) => !isGroup(n) && (n as any).track.id === tA.id) as any;
    expect(child).toBeTruthy();
    expect(child.opacity).toBeCloseTo(0.5, 6); // child's OWN level (NOT 0.25)
  });

  it('a group with NO contributing children is omitted', () => {
    // tA grouped but with no active clip at this beat → the group has nothing to draw.
    const gid = groupAround(tA.id);
    const tree = store.compositeTreeAtBeat(52);
    expect(tree.some((n) => isGroup(n) && n.group.id === gid)).toBe(false);
  });

  it('a bypassed group drops its whole subtree', () => {
    engineClip(tA.id, 50);
    engineClip(tB.id, 50);
    const gid = groupAround(tA.id);
    store.toggleBypass(gid);
    const tree = store.compositeTreeAtBeat(52);
    expect(tree.some((n) => isGroup(n) && n.group.id === gid)).toBe(false);
    // tB (independent sibling) still renders.
    expect(tree.some((n) => !isGroup(n) && (n as any).track.id === tB.id)).toBe(true);
  });

  it('soloing a group auditions its lineage only', () => {
    engineClip(tA.id, 50);
    engineClip(tB.id, 50);
    const gid = groupAround(tA.id);
    store.toggleSolo(gid);
    const tree = store.compositeTreeAtBeat(52);
    const g = tree.find((n) => isGroup(n) && n.group.id === gid) as CompositeGroupNode;
    expect(g).toBeTruthy();
    expect(g.children.some((n) => !isGroup(n) && (n as any).track.id === tA.id)).toBe(true);
    expect(tree.some((n) => !isGroup(n) && (n as any).track.id === tB.id)).toBe(false);
  });

  it('the group input defaults to transparent and is settable (undoable)', () => {
    const gid = groupAround(tA.id);
    expect(store.groupInputMode(gid)).toBe('transparent');
    store.setGroupInput(gid, 'underlying');
    expect(store.groupInputMode(gid)).toBe('underlying');
    store.setGroupInput(gid, 'custom', '#123456');
    expect(store.groupInputMode(gid)).toBe('custom');
    expect(store.groupInputColor(gid)).toBe('#123456');
    // Rapid same-key edits coalesce into one undo step → back to the default.
    store.undo();
    expect(store.groupInputMode(gid)).toBe('transparent');
  });

  it('the group node carries the configured input mode', () => {
    engineClip(tA.id, 50);
    const gid = groupAround(tA.id);
    store.setGroupInput(gid, 'black');
    const tree = store.compositeTreeAtBeat(52);
    const g = tree.find((n) => isGroup(n) && n.group.id === gid) as CompositeGroupNode;
    expect(g.input.mode).toBe('black');
  });
});
