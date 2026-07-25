import { describe, it, expect } from 'vitest';
import { store, paths } from './store';
import { isSequenceClip, mediaSourceKeys, mediaClips } from '../model/composition';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins();

/**
 * Editing TRANSPORT sections (transport-controller / follow / transition
 * effects) — on ordinary clips, on scene tracks, and on a sequence clip's
 * interior sub-clips.
 */

function makeSequence() {
  const t = store.addTrack();
  store.createEmptyClip(t, 0, 4);
  store.createEmptyClip(t, 4, 4);
  store.setTimeSelection(0, 8, [t]);
  store.consolidateSelection();
  const seq = store.trackById(t)!.clips.find(isSequenceClip)!;
  return { trackId: t, seqId: seq.id, laneId: seq.sequence!.id, subId: seq.sequence!.clips[0].id };
}

/** Focus the Nth effect card of a sketch, the way <column-group> does. */
function focusEffect(sketchId: string, chainIdx: number) {
  store.setChainFocus(`effect/${sketchId}/0/${chainIdx}`);
}

describe('transport-section effects can be deleted', () => {
  it('Delete removes a CLIP transport device (it used to only clear focus)', () => {
    const t = store.addTrack();
    const p = store.createEmptyClip(t, 0, 8)!;
    const clipId = p.split('/')[2];
    store.addClipTransportDevice(t, clipId, 'core.transport.time');
    expect(store.clipIn(t, clipId)!.transport!.devices).toHaveLength(1);

    focusEffect(`transport/${t}/${clipId}`, 0);
    store.deleteChainFocus();

    // An emptied section is dropped entirely (the clip reverts to its play mode).
    expect(store.clipIn(t, clipId)!.transport?.devices ?? []).toHaveLength(0);
  });

  it('Delete removes a TRACK transition device', () => {
    const s = store.addSceneTrack();
    store.insertTrackTransportDeviceAt(s, 0, 'core.transport.follow');
    expect(store.trackById(s)!.transport!.devices).toHaveLength(1);

    focusEffect(`transport/${s}`, 0);
    store.deleteChainFocus();

    expect(store.trackById(s)!.transport?.devices ?? []).toHaveLength(0);
  });

  it('copy/cut of a transport device resolves (it returned null before)', () => {
    const t = store.addTrack();
    const p = store.createEmptyClip(t, 0, 8)!;
    const clipId = p.split('/')[2];
    store.addClipTransportDevice(t, clipId, 'core.transport.time');

    focusEffect(`transport/${t}/${clipId}`, 0);
    expect(store.copyChainFocus()).toBe(true);
    store.cutChainFocus();
    expect(store.clipIn(t, clipId)!.transport?.devices ?? []).toHaveLength(0);
  });
});

describe('transport sections on interior sub-clips', () => {
  it('a follow effect can be added to, and removed from, an interior sub-clip', () => {
    const { laneId, subId } = makeSequence();

    store.addClipTransportDevice(laneId, subId, 'core.transport.follow');
    const devs = store.clipIn(laneId, subId)!.transport!.devices;
    expect(devs.map((d) => d.moduleType)).toEqual(['core.transport.follow']);

    focusEffect(`transport/${laneId}/${subId}`, 0);
    store.deleteChainFocus();
    expect(store.clipIn(laneId, subId)!.transport?.devices ?? []).toHaveLength(0);
  });

  it('a transition effect can be added to the interior LANE (scene mode)', () => {
    const { trackId, seqId, laneId } = makeSequence();
    store.setSequenceLaneKind(trackId, seqId, 'scene');

    store.insertTrackTransportDeviceAt(laneId, 0, 'core.transport.follow');
    expect(store.laneById(laneId)!.transport!.devices.map((d) => d.moduleType))
      .toEqual(['core.transport.follow']);

    focusEffect(`transport/${laneId}`, 0);
    store.deleteChainFocus();
    expect(store.laneById(laneId)!.transport?.devices ?? []).toHaveLength(0);
  });
});

describe('the details panel does not follow interior selection', () => {
  it('selecting a sub-clip keeps the panel on the SEQUENCE clip', () => {
    const { trackId, seqId, laneId, subId } = makeSequence();
    store.select(paths.clip(trackId, seqId));
    expect(store.clipViewTarget?.clip.id).toBe(seqId);

    // A single click inside the lane selects the sub-clip (the inspector
    // follows) but must NOT swap the panel out from under the lane.
    store.selectClipOnly(paths.clip(laneId, subId));
    expect(store.primaryPath).toBe(paths.clip(laneId, subId));
    expect(store.clipViewTarget?.clip.id).toBe(seqId);
  });

  it('only an explicit pin (double-click) retargets the panel', () => {
    const { trackId, seqId, laneId, subId } = makeSequence();
    store.select(paths.clip(trackId, seqId));

    store.setClipViewTarget(paths.clip(laneId, subId));
    expect(store.clipViewTarget?.clip.id).toBe(subId);

    // Selecting a sibling inside the SAME lane keeps the pin (you're still
    // working inside that sequence).
    const sibling = store.laneById(laneId)!.clips[1].id;
    store.selectClipOnly(paths.clip(laneId, sibling));
    expect(store.clipViewTarget?.clip.id).toBe(subId);

    // Selecting something unrelated drops it back to the selection.
    const other = store.addTrack();
    const op = store.createEmptyClip(other, 0, 4)!;
    store.select(op);
    expect(store.clipViewTarget?.clip.id).toBe(op.split('/')[2]);
  });
});

/**
 * MEDIA RELINK. Blob URLs die on reload, so `relinkMedia` re-resolves every
 * media key and rewrites the matching clips' `source.url`. Enumerating only
 * top-level clips left a sequence's interior sub-clips pointing at the DEAD
 * pre-reload blob — the decode service could never open them, so they rendered
 * transparent, and with no "missing media" warning either (their key never
 * entered the relink set).
 */
describe('media enumeration reaches sequence interiors', () => {
  it('collects sourceKeys from interior sub-clips', () => {
    const t = store.addTrack();
    const media = { sourceKey: 'inner_key', url: 'blob:dead', frameCount: 55, fps: 30 };
    store.addVideoClip(t, 0, media as any, 4);
    store.addVideoClip(t, 4, media as any, 4);
    store.setTimeSelection(0, 8, [t]);
    store.consolidateSelection();

    // The clips now live ONLY inside the sequence.
    expect(store.trackById(t)!.clips.every(isSequenceClip)).toBe(true);
    expect([...mediaSourceKeys(store.composition)]).toContain('inner_key');
    expect([...mediaClips(store.composition)].length).toBeGreaterThanOrEqual(2);
  });

  it('rewrites interior source urls (what relinkMedia does after a reload)', () => {
    const t = store.addTrack();
    const media = { sourceKey: 'relink_key', url: 'blob:dead', frameCount: 55, fps: 30 };
    store.addVideoClip(t, 0, media as any, 8);
    store.setTimeSelection(0, 8, [t]);
    store.consolidateSelection();

    for (const c of mediaClips(store.composition)) {
      if (c.source!.sourceKey === 'relink_key') c.source!.url = 'blob:fresh';
    }
    const seq = store.trackById(t)!.clips.find(isSequenceClip)!;
    for (const sub of seq.sequence!.clips) {
      expect(sub.source!.url).toBe('blob:fresh');
    }
  });
});
