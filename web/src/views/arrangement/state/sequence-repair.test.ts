import { describe, it, expect } from 'vitest';
import { store } from './store';
import { duplicateDocIds } from './lane-resolve';

/**
 * Load-time healing of sequence clips (`ArrangementStore.repairIds`).
 *
 * Consolidate never produces any of these shapes — they come from hand-edited
 * files, a future version, or an older duplication path that deep-copied a clip
 * without minting fresh inner ids. Each one is silent if unhealed:
 *   - NESTING breaks the one-level invariant every downstream walk relies on
 *     (native `parseClip` drops depth ≥ 1 outright, so the interior would
 *     simply vanish on the engine side while the web UI still showed it).
 *   - A LANE ID colliding with a track id merges two sequences' engine
 *     instances — lane ids share the track-id namespace (`trackInstanceKey`,
 *     `sceneLaunchState`).
 *   - A DUPLICATE clip or device id makes two things emit one instance key, and
 *     `Builder::push` silently DROPS the second → black output, no error.
 */

/** repairIds is private static; the load path reaches it the same way. */
const repair = (comp: any) => (store.constructor as any).repairIds(comp);

const clip = (id: string, startBeat: number, lengthBeat: number, extra: any = {}) => ({
  id, name: id, startBeat, lengthBeat, kind: 'effect',
  sketch: { devices: [] }, automation: [], exports: [], warps: [], ...extra,
});

const lane = (id: string, clips: any[], kind: 'track' | 'scene' = 'track') => ({
  id, name: 'seq', kind, parentId: null,
  sketch: { devices: [] }, transport: { devices: [] }, automation: [], clips,
});

const seqClip = (id: string, startBeat: number, lengthBeat: number, l: any) =>
  clip(id, startBeat, lengthBeat, { kind: 'sequence', sequence: l });

const doc = (tracks: any[]) => ({
  meta: { baseBPM: 120, timeSignature: [4, 4] },
  tracks, rails: [],
});

describe('repairIds: sequence hygiene on load', () => {
  it('explodes a NESTED sequence in place, lifting sub-clips to absolute interior beats', () => {
    // outer[0,16) ⊃ inner-wrapper[4,8) ⊃ { a@0, b@2 }  →  the wrapper dissolves.
    const inner = lane('lane_inner', [clip('a', 0, 2), clip('b', 2, 2)]);
    const outer = lane('lane_outer', [
      clip('head', 0, 4),
      seqClip('wrapper', 4, 8, inner),
    ]);
    const comp: any = doc([
      { id: 't1', name: 'T', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [seqClip('seq', 0, 16, outer)] },
    ]);

    repair(comp);

    const lifted = comp.tracks[0].clips[0].sequence.clips;
    expect(lifted.map((c: any) => c.id)).toEqual(['head', 'a', 'b']);
    // Interior beats are absolute within the lane: wrapper.start + inner.start.
    expect(lifted.map((c: any) => [c.startBeat, c.lengthBeat]))
      .toEqual([[0, 4], [4, 2], [6, 2]]);
    // Provably 2-deep afterwards: only TOP-LEVEL tracks may hold a sequence clip.
    for (const t of comp.tracks) {
      for (const c of t.clips) {
        expect(c.sequence?.clips.some((x: any) => x.sequence) ?? false).toBe(false);
      }
    }
  });

  it('drops a nested sub-clip that starts beyond its wrapper, and clips one that overruns', () => {
    const inner = lane('lane_inner', [clip('keep', 0, 8), clip('gone', 6, 2)]);
    const outer = lane('lane_outer', [seqClip('wrapper', 0, 4, inner)]);
    const comp: any = doc([
      { id: 't1', name: 'T', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [seqClip('seq', 0, 8, outer)] },
    ]);

    repair(comp);

    const lifted = comp.tracks[0].clips[0].sequence.clips;
    expect(lifted.map((c: any) => c.id)).toEqual(['keep']);   // 'gone' starts at 6 ≥ 4
    expect(lifted[0].lengthBeat).toBe(4);                     // truncated to the wrapper
  });

  it('re-mints a lane id that is blank or collides with a TRACK id (one namespace)', () => {
    const comp: any = doc([
      { id: 't1', name: 'A', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [seqClip('s1', 0, 4, lane('', [clip('x', 0, 4)]))] },
      { id: 't2', name: 'B', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [seqClip('s2', 0, 4, lane('t1', [clip('y', 0, 4)]))] },
    ]);

    repair(comp);

    const l1 = comp.tracks[0].clips[0].sequence.id;
    const l2 = comp.tracks[1].clips[0].sequence.id;
    expect(l1).toBeTruthy();
    expect(l2).not.toBe('t1');           // would have merged with the track's instances
    expect(new Set(['t1', 't2', l1, l2]).size).toBe(4);
  });

  it('re-mints a lane id that collides with ANOTHER sequence lane', () => {
    const comp: any = doc([
      { id: 't1', name: 'A', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [
          seqClip('s1', 0, 4, lane('dup', [clip('x', 0, 4)])),
          seqClip('s2', 4, 4, lane('dup', [clip('y', 0, 4)])),
        ] },
    ]);

    repair(comp);

    const [a, b] = comp.tracks[0].clips.map((c: any) => c.sequence.id);
    expect(a).not.toBe(b);
  });

  it('heals a duplicate clip id across the sequence boundary and freshens its innards', () => {
    // 'dupe' appears both on the track and inside a lane — one instance key.
    const comp: any = doc([
      { id: 't1', name: 'A', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [
          clip('dupe', 0, 4, { sketch: { devices: [{ id: 'dev1', moduleType: 'm' }] } }),
          seqClip('s1', 8, 4, lane('lane1', [
            clip('dupe', 0, 4, { sketch: { devices: [{ id: 'dev1', moduleType: 'm' }] } }),
          ])),
        ] },
    ]);

    repair(comp);

    const outerId = comp.tracks[0].clips[0].id;
    const innerId = comp.tracks[0].clips[1].sequence.clips[0].id;
    expect(outerId).toBe('dupe');        // first wins
    expect(innerId).not.toBe('dupe');    // second re-minted...
    // ...and its inner ids came with it (a shared device id is the same bug).
    expect(comp.tracks[0].clips[1].sequence.clips[0].sketch.devices[0].id).not.toBe('dev1');
    expect(duplicateDocIds(comp)).toEqual([]);
  });

  it('heals duplicate DEVICE ids inside an interior sub-clip and on the lane bus', () => {
    const comp: any = doc([
      { id: 't1', name: 'A', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [
          seqClip('s1', 0, 4, {
            ...lane('lane1', [
              clip('sub', 0, 4, { sketch: { devices: [
                { id: 'd', moduleType: 'm1' }, { id: 'd', moduleType: 'm2' },
              ] } }),
            ]),
            sketch: { devices: [{ id: 'x', moduleType: 'm3' }, { id: 'x', moduleType: 'm4' }] },
          }),
        ] },
    ]);

    repair(comp);

    const l = comp.tracks[0].clips[0].sequence;
    expect(new Set(l.clips[0].sketch.devices.map((d: any) => d.id)).size).toBe(2);
    expect(new Set(l.sketch.devices.map((d: any) => d.id)).size).toBe(2);
  });

  it('reconciles kind with the payload in both directions', () => {
    const comp: any = doc([
      { id: 't1', name: 'A', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [
          // Claims to be a sequence but carries no lane — every isSequenceClip()
          // reader would disagree with the payload.
          clip('bare', 0, 4, { kind: 'sequence' }),
          // Carries a lane but claims otherwise (an older file, pre-`kind`).
          clip('latent', 4, 4, { sequence: lane('lane1', [clip('x', 0, 4)]) }),
        ] },
    ]);

    repair(comp);

    expect(comp.tracks[0].clips[0].kind).toBe('effect');
    expect(comp.tracks[0].clips[1].kind).toBe('sequence');
  });

  it('leaves a well-formed sequence structurally untouched', () => {
    const comp: any = doc([
      { id: 't1', name: 'A', kind: 'track', parentId: null, sketch: { devices: [] },
        automation: [], clips: [seqClip('s1', 0, 8, lane('lane1', [
          clip('a', 0, 4), clip('b', 4, 4),
        ]))] },
    ]);

    repair(comp);

    // (repairClipLoop legitimately seeds a default `loop` on every clip — the
    // shape assertion is about IDs and structure, which must not move.)
    const seq = comp.tracks[0].clips[0];
    expect(comp.tracks[0].clips).toHaveLength(1);
    expect(seq.id).toBe('s1');
    expect(seq.kind).toBe('sequence');
    expect(seq.sequence.id).toBe('lane1');
    expect(seq.sequence.clips.map((c: any) => [c.id, c.startBeat, c.lengthBeat]))
      .toEqual([['a', 0, 4], ['b', 4, 4]]);
    expect(duplicateDocIds(comp)).toEqual([]);
  });
});
