import { describe, it, expect, beforeEach, vi } from 'vitest';
import { store } from './store';
import { sceneChannelAssignments, compositionLengthBeats, type Track } from '../model/composition';

/**
 * Scene tracks: launchable clips outside the timeline. Covers creation +
 * guards, channel auto-assignment (lock-step: comp_model.h), transient launch
 * state (never undoable), and the timeline-extent exclusion.
 */
describe('scene tracks', () => {
  beforeEach(() => {
    // Fresh doc: reset via the public seams (the store is a singleton).
    while (store.canUndo) store.undo();
    store.setSceneLaunchState({});
    store.sceneOpSink = null;
  });

  const addSceneWith = (trackId: string, name?: string): string => {
    const path = store.createEmptyClip(trackId, 0)!;
    const clip = store.trackById(trackId)!.clips.at(-1)!;
    if (name) store.renameClip(trackId, clip.id, name);
    void path;
    return clip.id;
  };

  it('addSceneTrack creates a kind:scene track above the main bus', () => {
    const id = store.addSceneTrack();
    const t = store.trackById(id)!;
    expect(t.kind).toBe('scene');
    const idx = store.composition.tracks.findIndex((x) => x.id === id);
    const busIdx = store.composition.tracks.findIndex((x) => store.isMainBus(x));
    expect(idx).toBeLessThan(busIdx);
  });

  it('createEmptyClip places grid-positioned scenes with the FIXED one-bar width', () => {
    const id = store.addSceneTrack();
    expect(store.createEmptyClip(id, 12)).not.toBeNull();
    const t = store.trackById(id)!;
    expect(t.clips.length).toBe(1);
    expect(t.clips[0].startBeat).toBe(12);          // grid-placed, not pinned
    expect(t.clips[0].lengthBeat).toBe(store.barBeats); // rigid one-bar cell
  });

  it('scenes are RIGID: an overlapping drop pushes siblings right, never carves', () => {
    const id = store.addSceneTrack();
    const a = addSceneWith(id);                     // [0, 4)
    store.addVideoClip(id, 2, { sourceKey: 'k', url: 'blob:x', frameCount: 30, fps: 30, label: 'v' }, 8);
    const t = store.trackById(id)!;
    expect(t.clips.length).toBe(2);                 // nothing deleted
    const video = t.clips.find((c) => c.kind === 'video')!;
    const scene = t.clips.find((c) => c.id === a)!;
    expect(video.startBeat).toBe(2);                // the dropped cell keeps its spot
    expect(video.lengthBeat).toBe(store.barBeats);  // forced to the fixed width
    expect(scene.startBeat).toBe(6);                // pushed past the new cell
  });

  it('moveClip on a scene track chain-pushes overlapped cells', () => {
    const id = store.addSceneTrack();
    const a = addSceneWith(id);                     // [0,4)
    store.moveClip(id, addSceneWith(id), 4);        // b → [4,8)
    const c = addSceneWith(id);
    store.moveClip(id, c, 8);                       // c → [8,12)
    // Move A onto B: B pushes past A's new span, chaining into C.
    store.moveClip(id, a, 4);
    const t = store.trackById(id)!;
    const by = (cid: string) => t.clips.find((x) => x.id === cid)!.startBeat;
    expect(by(a)).toBe(4);
    expect(by(t.clips[1].id)).toBe(8);              // b pushed
    expect(by(c)).toBe(12);                         // c chained
  });

  it('clips drag to/from scene tracks (fixed width on the way in)', () => {
    const id = store.addSceneTrack();
    const trk = store.addTrack();
    const path = store.createEmptyClip(trk, 0, 16)!; // a long normal clip
    const clipId = path.split('/')[2];
    store.moveClipToTrack(trk, clipId, id, 8);
    let t = store.trackById(id)!;
    expect(t.clips.length).toBe(1);
    expect(t.clips[0].startBeat).toBe(8);
    expect(t.clips[0].lengthBeat).toBe(store.barBeats); // snapped to the cell width
    // Break the move:<id> coalescing (two DISTINCT gestures, not one drag).
    store.setTrackLevel(id, 0.9);
    // ...and back out to a plain track (keeps the bar length; resizable there).
    store.moveClipToTrack(id, clipId, trk, 2);
    expect(store.trackById(id)!.clips.length).toBe(0);
    expect(store.trackById(trk)!.clips[0].startBeat).toBe(2);
  });

  it('clip creation still rejects groups and rails', () => {
    const railTrack = store.addReturn();
    expect(store.createEmptyClip(railTrack, 0)).toBeNull();
    const grp = store.addGroup();
    expect(store.createEmptyClip(grp, 0)).toBeNull();
  });

  it('grid-placed scenes count toward the composition length (they are ON the timeline)', () => {
    const id = store.addSceneTrack();
    addSceneWith(id);
    store.moveClip(id, store.trackById(id)!.clips[0].id, 100);
    expect(compositionLengthBeats(store.composition)).toBe(100 + store.barBeats);
  });

  describe('channel auto-assignment (lock-step: comp_model.h)', () => {
    const mkTrack = (channels: Array<number | undefined>): Track => ({
      id: 't', name: 't', kind: 'scene', parentId: null,
      sketch: { devices: [] }, automation: [],
      clips: channels.map((ch, i) => ({
        id: `s${i}`, name: `s${i}`, startBeat: 0, lengthBeat: 8, kind: 'effect' as const,
        sketch: { devices: [] }, loop: { mode: 'time' as const, startSec: 0, speed: 1, direction: 'forward' as const },
        automation: [], exports: [], warps: [],
        ...(ch != null ? { triggerChannel: ch } : {}),
      })),
    });

    it.each([
      [[undefined, undefined, undefined], [1, 2, 3]],
      [[5, undefined, undefined], [5, 1, 2]],
      [[undefined, 1, undefined], [2, 1, 3]],
      [[2, 2, undefined], [2, 2, 1]],     // duplicate explicits keep their number
      [[undefined, 3, 1], [2, 3, 1]],
      [[], []],
    ] as Array<[Array<number | undefined>, number[]]>)('%j → %j', (channels, expected) => {
      expect(sceneChannelAssignments(mkTrack(channels))).toEqual(expected);
    });

    it('auto channels follow GRID order (startBeat), not array order', () => {
      const t = mkTrack([undefined, undefined, undefined]);
      t.clips[0].startBeat = 8;   // array-first but grid-last
      t.clips[1].startBeat = 0;
      t.clips[2].startBeat = 4;
      expect(sceneChannelAssignments(t)).toEqual([3, 1, 2]);
    });
  });

  it('setSceneChannel pins / clears (auto) and is undoable', () => {
    const id = store.addSceneTrack();
    const sceneId = addSceneWith(id);
    store.setSceneChannel(id, sceneId, 7);
    expect(store.trackById(id)!.clips[0].triggerChannel).toBe(7);
    store.setSceneChannel(id, sceneId, null);
    expect(store.trackById(id)!.clips[0].triggerChannel).toBeUndefined();
    store.undo();
    expect(store.trackById(id)!.clips[0].triggerChannel).toBe(7);
  });

  it('launchScene is transient: optimistic mirror + sink op, NOT in undo history', () => {
    const id = store.addSceneTrack();
    const sceneId = addSceneWith(id);
    const ops: unknown[] = [];
    store.sceneOpSink = (msg) => ops.push(msg);
    const undoDepthBefore = store.canUndo;

    store.launchScene(id, sceneId);
    expect(store.sceneLaunchState[id]?.sceneId).toBe(sceneId);
    expect(ops).toEqual([{ op: 'launchScene', trackId: id, sceneId }]);
    expect(store.canUndo).toBe(undoDepthBefore); // no history entry

    store.stopScene(id);
    expect(store.sceneLaunchState[id]).toBeUndefined();
    expect(ops[1]).toEqual({ op: 'stopScene', trackId: id });
  });

  it('launchedScene resolves the launched clip and skips bypassed/dangling', () => {
    const id = store.addSceneTrack();
    const sceneId = addSceneWith(id);
    const t = store.trackById(id)!;
    // Empty scene (no devices, no media) → not renderable, not "launched".
    store.setSceneLaunchState({ [id]: { sceneId, launchBeat: 0 } });
    expect(store.launchedScene(t)).toBeUndefined();
    // Give it a device → resolves.
    t.clips[0].sketch.devices.push({ id: 'd', moduleType: 'source.solid_color', name: 'solid', capabilities: [], state: {} });
    expect(store.launchedScene(t)?.id).toBe(sceneId);
    // Dangling id → undefined.
    store.setSceneLaunchState({ [id]: { sceneId: 'nope', launchBeat: 0 } });
    expect(store.launchedScene(t)).toBeUndefined();
  });

  it('compositeTreeAtBeat renders the launched scene (and only then)', () => {
    const id = store.addSceneTrack();
    const sceneId = addSceneWith(id);
    const t = store.trackById(id)!;
    t.clips[0].sketch.devices.push({ id: 'd', moduleType: 'source.solid_color', name: 'solid', capabilities: [], state: {} });
    expect(store.compositeTreeAtBeat(0).length).toBe(0);
    store.setSceneLaunchState({ [id]: { sceneId, launchBeat: 0 } });
    const tree = store.compositeTreeAtBeat(0);
    expect(tree.length).toBe(1);
    expect(tree[0].type).toBe('clip');
  });

  it('serialization round-trips scene fields structurally', () => {
    const id = store.addSceneTrack();
    const sceneId = addSceneWith(id);
    store.setSceneChannel(id, sceneId, 3);
    const json = JSON.parse(JSON.stringify(store.composition));
    const t = json.tracks.find((x: Track) => x.id === id);
    expect(t.kind).toBe('scene');
    expect(t.clips[0].triggerChannel).toBe(3);
  });
});
