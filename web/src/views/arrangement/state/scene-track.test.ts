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

  it('createEmptyClip admits scene tracks and pins startBeat to 0', () => {
    const id = store.addSceneTrack();
    expect(store.createEmptyClip(id, 12)).not.toBeNull();
    const t = store.trackById(id)!;
    expect(t.clips.length).toBe(1);
    expect(t.clips[0].startBeat).toBe(0);
  });

  it('addVideoClip appends a scene without carving siblings', () => {
    const id = store.addSceneTrack();
    addSceneWith(id);
    store.addVideoClip(id, 4, { sourceKey: 'k', url: 'blob:x', frameCount: 30, fps: 30, label: 'v' }, 8);
    const t = store.trackById(id)!;
    expect(t.clips.length).toBe(2); // no carve — scenes co-exist at beat 0
    expect(t.clips[1].startBeat).toBe(0);
  });

  it('clip creation still rejects groups and rails', () => {
    const railTrack = store.addReturn();
    expect(store.createEmptyClip(railTrack, 0)).toBeNull();
    const grp = store.addGroup();
    expect(store.createEmptyClip(grp, 0)).toBeNull();
  });

  it('scene extents do not inflate the composition length', () => {
    const id = store.addSceneTrack();
    const sceneId = addSceneWith(id);
    store.trackById(id)!.clips[0].lengthBeat = 500; // fake extent
    void sceneId;
    expect(compositionLengthBeats(store.composition)).toBe(64);
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
