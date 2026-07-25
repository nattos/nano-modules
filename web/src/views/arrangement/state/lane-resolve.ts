/**
 * lane-resolve — the ONE place a "lane id" resolves to the Track that holds the
 * clips, whether that's a top-level track or a sequence clip's interior lane.
 *
 * Deliberately pure and Composition-shaped: no MobX, no store import. That lets
 * the same functions serve BOTH the read path (`store.laneById` on the live
 * observable) and the write path (inside an immer `mutate` recipe, on the
 * draft). Two resolvers would drift; one cannot.
 *
 * Note the deliberate split against `store.trackById`, which stays TOP-LEVEL
 * ONLY: its callers read `.level`/`.parentId`/`.collapsed`/`.soloed` and feed
 * `ancestorsOf`/`trackDepth`/`visibleTracks` — track-structure concepts an
 * interior lane does not participate in. Use `laneById` whenever you are
 * addressing CLIPS; use `trackById` when you mean a row in the arrangement.
 */

import type { Clip, Composition, Track } from '../model/composition';
import { allLanes } from '../model/composition';

/**
 * Resolve a lane id → the Track holding its clips. Top-level tracks win (they
 * are checked first), then each sequence clip's interior lane.
 */
export function laneById(comp: Composition, id: string): Track | undefined {
  if (!id) return undefined;
  const top = comp.tracks.find((t) => t.id === id);
  if (top) return top;
  for (const track of comp.tracks) {
    for (const clip of track.clips) {
      if (clip.sequence?.id === id) return clip.sequence;
    }
  }
  return undefined;
}

/** (laneId, clipId) → clip. Replaces every `trackById(x)?.clips.find(y)`. */
export function clipIn(comp: Composition, laneId: string, clipId: string): Clip | undefined {
  return laneById(comp, laneId)?.clips.find((c) => c.id === clipId);
}

/** The lane id owning `clipId`, searching every lane (interiors included). */
export function laneIdOfClip(comp: Composition, clipId: string): string | undefined {
  for (const lane of allLanes(comp)) {
    if (lane.clips.some((c) => c.id === clipId)) return lane.id;
  }
  return undefined;
}

/** Does `id` name a sequence clip's INTERIOR lane (rather than a top-level track)? */
export function isSequenceLaneId(comp: Composition, id: string): boolean {
  if (!id) return false;
  if (comp.tracks.some((t) => t.id === id)) return false;
  return comp.tracks.some((t) => t.clips.some((c) => c.sequence?.id === id));
}

/**
 * Every duplicated id in the document, across ALL lanes. Duplicate ids are a
 * silent-corruption class, not a cosmetic one: engine instance keys are built
 * from clip/lane/device ids, and the native `Builder::push` (sketch_build.h)
 * DROPS a duplicate key without a word — so a bad clone renders black with no
 * error anywhere. Used by a DEV-only tripwire in `store.mutate` and by the
 * clone tests.
 */
export function duplicateDocIds(comp: Composition): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const note = (kind: string, id: string | undefined) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) dupes.add(key);
    else seen.add(key);
  };
  for (const lane of allLanes(comp)) {
    note('lane', lane.id);
    for (const d of lane.sketch?.devices ?? []) note('device', d.id);
    for (const d of lane.transport?.devices ?? []) note('device', d.id);
    for (const l of lane.automation ?? []) note('auto', l.id);
    for (const clip of lane.clips) {
      note('clip', clip.id);
      for (const d of clip.sketch?.devices ?? []) note('device', d.id);
      for (const d of clip.transport?.devices ?? []) note('device', d.id);
      for (const l of clip.automation ?? []) note('auto', l.id);
    }
  }
  return [...dupes];
}
