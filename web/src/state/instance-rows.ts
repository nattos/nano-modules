/**
 * Organize barrel instances into Resolume-shaped rows for the Instances tab.
 *
 * One row per layer-group / track, plus a "Main" row for composition-level
 * effects. Rows read TOP-DOWN like Resolume's layer stack: the highest layer
 * index first (Resolume draws layer 1 at the bottom), so the Instances tab and
 * the Arena window agree at a glance. Within a track row, effects mounted on the
 * track ITSELF lead (`leading`), then a divider, then the track's clip-mounted
 * effects (`clips`), each in composition order. A group row has only leading
 * effects (groups have no clips in our scan); the Main row likewise.
 *
 * Instances with no known placement (playground, or a launched instance before
 * its Resolume info arrives) collect into a trailing "Other" row. When NOTHING
 * has placement, `buildInstanceRows` returns `null` — the caller falls back to
 * the plain flow grid (the playground case, where rows would be meaningless).
 *
 * Pure + DOM-free so it can be unit-tested without booting the app.
 */

import type { BarrelInstanceInfo } from './types';

export interface InstanceRow {
  /** Stable lane identity (`g:<i>` / `t:<i>` / `main` / `other`). */
  laneKey: string;
  /** Row header label. */
  label: string;
  /** Effects on the group/track/composition itself, in chain order. */
  leading: BarrelInstanceInfo[];
  /** Clip-mounted effects (tracks only), in clip then chain order. */
  clips: BarrelInstanceInfo[];
}

// Row ordering: groups first, then tracks, then Main, then Other last. Group and
// track index spaces are separate in the composition, so they can't be perfectly
// interleaved without layer-group membership data (which the native scan doesn't
// currently carry); banding keeps the common no-groups case exactly in
// composition order.
//
// WITHIN the group and track bands the index sorts DESCENDING, because Resolume's
// layer stack is bottom-up: `track_index` 0 is "Layer 1", which Arena draws at the
// BOTTOM. Ascending order put the tab upside-down relative to the window it
// mirrors. Main / Other are single lanes, so the direction doesn't reach them.
const GROUP_BAND = 0;
const TRACK_BAND = 1;
const MAIN_BAND = 2;
const OTHER_BAND = 3;

interface LaneAccum extends InstanceRow { band: number; index: number }

const chainIdx = (i: BarrelInstanceInfo) => i.resolumePlacement?.chainIndex ?? 0;
const clipIdx = (i: BarrelInstanceInfo) => i.resolumePlacement?.clipIndex ?? 0;

/**
 * Group `instances` into composition-ordered rows, or return `null` if none
 * carry placement (caller renders a flat grid instead).
 */
export function buildInstanceRows(instances: BarrelInstanceInfo[]): InstanceRow[] | null {
  if (!instances.some((i) => i.resolumePlacement)) return null;

  const lanes = new Map<string, LaneAccum>();
  const lane = (laneKey: string, band: number, index: number, label: string): LaneAccum => {
    let l = lanes.get(laneKey);
    if (!l) {
      l = { laneKey, band, index, label, leading: [], clips: [] };
      lanes.set(laneKey, l);
    }
    // A later, better label (e.g. a named track after an unnamed fallback) wins.
    if (label && !l.label) l.label = label;
    return l;
  };

  for (const inst of instances) {
    const p = inst.resolumePlacement;
    if (!p) {
      lane('other', OTHER_BAND, 0, 'Other').leading.push(inst);
      continue;
    }
    switch (p.scope) {
      case 'group': {
        const gi = p.groupIndex ?? 0;
        lane(`g:${gi}`, GROUP_BAND, gi, p.groupName || `Group ${gi + 1}`).leading.push(inst);
        break;
      }
      case 'layer': {
        const ti = p.trackIndex ?? 0;
        lane(`t:${ti}`, TRACK_BAND, ti, p.trackName || `Track ${ti + 1}`).leading.push(inst);
        break;
      }
      case 'clip': {
        const ti = p.trackIndex ?? 0;
        lane(`t:${ti}`, TRACK_BAND, ti, p.trackName || `Track ${ti + 1}`).clips.push(inst);
        break;
      }
      case 'composition':
        lane('main', MAIN_BAND, 0, 'Main').leading.push(inst);
        break;
    }
  }

  // Band ascending, but index DESCENDING within a band — Resolume's stack is
  // bottom-up (layer index 0 = "Layer 1" = bottom of the Arena window).
  const rows = [...lanes.values()].sort(
    (a, b) => a.band - b.band || b.index - a.index || a.laneKey.localeCompare(b.laneKey));
  for (const r of rows) {
    r.leading.sort((a, b) => chainIdx(a) - chainIdx(b));
    r.clips.sort((a, b) => clipIdx(a) - clipIdx(b) || chainIdx(a) - chainIdx(b));
  }
  return rows.map(({ laneKey, label, leading, clips }) => ({ laneKey, label, leading, clips }));
}
