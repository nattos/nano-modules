/**
 * composite-frame — the SHARED "timeline at a beat → engine commands" logic, so
 * the live preview (`EngineBridge`) and the offline exporter render byte-identical
 * frames. Three concerns live here, each a pure function of (the store, a beat):
 *
 *   - `videoDescFor(clip)` — the decode-pump descriptor for a video-backed clip.
 *   - `buildCompositeRenderAtBeat(layers, beat)` — fold the active engine layers
 *     into ONE composite sketch (rail bases + per-clip start-seconds baked in).
 *   - `automationEntriesAtBeat(beat)` — evaluate every active clip/track lane (and
 *     re-assert each rail's base) into the executor's parameter-automation writes.
 *
 * Both callers feed these to the engine the same way; the only difference is WHICH
 * beat (the live playhead vs. each exported frame) and WHICH engine (the preview
 * vs. the second, full-resolution export worker).
 */

import type { AutomationEntry } from './arr-engine';
import { buildCompositeSketch, clipInstanceKey, trackInstanceKey, type CompositeNode, type CompositeClipNode, type CompositeGroupNode } from './clip-sketch';
import { evalLaneAtBeat, evalCurveAt } from './automation-eval';
import { makeWarpClock, type WarpClock } from './warp-clock';
import { VIDEO_SOURCE_TYPE } from './effect-catalog';
import type { VideoClipDesc } from './video-compositor';
import { store } from '../state/store';
import { resolveSourceTransform, compositionLengthBeats, type Clip, type Track } from '../model/composition';

/** One engine layer to fold into the composite (as `store.compositeLayersAtBeat`
 *  returns, but accepting the bridge's looser optional shape too). */
export interface EngineLayer {
  clip: Clip;
  opacity?: number;
  blendMode?: number;
  track?: Track;
}

/** Build the decode-pump descriptor for a video-backed clip (or null if it isn't
 *  one). The `instanceKey` MUST match the clip's `source.video.file` entry in
 *  `buildCompositeSketch`, or the injected frame goes nowhere. */
export function videoDescFor(clip: Clip): VideoClipDesc | null {
  const src = clip.source;
  if (!src?.url) return null;
  const dev = clip.sketch.devices.find((d) => d.moduleType === VIDEO_SOURCE_TYPE);
  if (!dev) return null;
  return {
    clipId: clip.id,
    instanceKey: clipInstanceKey(clip.id, dev.id),
    url: src.url,
    sourceKey: src.sourceKey ?? clip.id,
    startBeat: clip.startBeat,
    lengthBeat: clip.lengthBeat,
    durationFrames: src.durationFrames,
    fps: src.fps,
    speed: clip.loop?.speed,
    scaleMode: src.scaleMode ?? 'fit',
    transform: resolveSourceTransform(src.transform),
    loop: clip.loop,
  };
}

/** Every clip leaf in a composite tree (depth-first). */
function flattenLeaves(tree: CompositeNode[]): CompositeClipNode[] {
  const out: CompositeClipNode[] = [];
  const walk = (ns: CompositeNode[]) => {
    for (const n of ns) {
      if ((n as CompositeGroupNode).type === 'group') walk((n as CompositeGroupNode).children);
      else out.push(n as CompositeClipNode);
    }
  };
  walk(tree);
  return out;
}

/** Per-rail base value + signed flag at `beat` (the return track's contract). */
function railBasesAtBeat(clips: Clip[], beat: number): {
  railBases: Map<string, number>;
  railSigned: Map<string, boolean>;
} {
  const totalBeats = compositionLengthBeats(store.composition);
  const railBases = new Map<string, number>();
  const railSigned = new Map<string, boolean>();
  for (const clip of clips) {
    for (const read of clip.reads ?? []) {
      if (railBases.has(read.railId)) continue;
      const rt = store.railTrackFor(read.railId);
      railBases.set(read.railId, rt?.baseCurve ? evalCurveAt(rt.baseCurve, totalBeats > 0 ? beat / totalBeats : 0) : 0);
      railSigned.set(read.railId, rt?.railSigned ?? false);
    }
  }
  return { railBases, railSigned };
}

/**
 * Fold the active composite TREE at `beat` into ONE composite sketch — group effect
 * chains run over their composited children, rail base-curve values and each clip's
 * absolute start-seconds baked in (warp-aware). Returns null when nothing contributes
 * (the caller renders the backdrop). `ignoreSolo` (the exporter) renders the full mix.
 * The `sig` lets a caller re-issue to the engine only when the composite changes.
 */
/** Warp clock memoized on `store.warpEpoch` — buildCompositeRenderAtBeat runs every
 *  monitor frame + every edit; rebuilding the clock (reads every clip's warp) each
 *  time was needless work on the slider-drag path. warpEpoch doesn't bump on param/
 *  transform edits, so a drag reuses the cached clock. */
let _clockCache: { epoch: number; clock: WarpClock } | null = null;
function cachedWarpClock(): WarpClock {
  if (!_clockCache || _clockCache.epoch !== store.warpEpoch) {
    _clockCache = { epoch: store.warpEpoch, clock: makeWarpClock(store.composition) };
  }
  return _clockCache.clock;
}

export function buildCompositeRenderAtBeat(beat: number, ignoreSolo = false) {
  const tree = store.compositeTreeAtBeat(beat, ignoreSolo);
  if (tree.length === 0) return null;
  const clock = cachedWarpClock();
  // Bake each clip leaf's absolute start time (s) onto its node, for effect seeks.
  const leaves = flattenLeaves(tree);
  for (const leaf of leaves) leaf.startSec = clock.secondsAt(leaf.clip.startBeat);
  const { railBases, railSigned } = railBasesAtBeat(leaves.map((l) => l.clip), beat);
  // The MAIN BUS runs its FX chain over the final composite (master FX bus), unless
  // bypassed. It's excluded from the composite tree (it isn't a content group), so
  // pass it explicitly.
  const bus = store.mainBusTrack;
  const masterBus = bus && !bus.bypassed ? bus : undefined;
  return buildCompositeSketch(tree, store.composition.meta.background, railBases, railSigned, masterBus);
}

/**
 * Evaluate this beat's parameter automation: every active CLIP lane (clip-relative
 * beats) and TRACK lane (absolute beats), plus a `replace` re-assertion of each
 * active rail's base value onto its accumulator `input` (so a dropped writer wire
 * resets the rail to base instead of holding the last modulated value). The
 * executor folds each entry into its target field via tap_mod.
 */
export function automationEntriesAtBeat(beat: number, ignoreSolo = false): AutomationEntry[] {
  const totalBeats = compositionLengthBeats(store.composition);
  const entries: AutomationEntry[] = [];
  const seenRail = new Set<string>();

  // A TRACK / GROUP lane targets its per-track(-group) FX bus (absolute beats).
  const pushTrackLanes = (track: Track) => {
    for (const lane of track.automation ?? []) {
      entries.push({
        instance: trackInstanceKey(track.id, lane.targetDeviceId),
        field: lane.targetField,
        value: evalLaneAtBeat(lane.points, { kind: 'track' }, beat),
        combine: lane.combine ?? 'replace',
        magnitude: lane.magnitude ?? 'unsigned',
      });
    }
  };

  // Walk the composite tree so GROUP automation (whose FX runs over its children)
  // emits alongside clip + track automation.
  const walk = (nodes: CompositeNode[]) => {
    for (const n of nodes) {
      if ((n as CompositeGroupNode).type === 'group') {
        const g = n as CompositeGroupNode;
        pushTrackLanes(g.group);
        walk(g.children);
        continue;
      }
      const { clip, track } = n as CompositeClipNode;
      for (const lane of clip.automation ?? []) {
        const ctx = {
          kind: 'clip' as const,
          startBeat: clip.startBeat,
          spanBeats: clip.lengthBeat,
          loopMode: store.clipAutoTiming === 'loop',
        };
        entries.push({
          instance: clipInstanceKey(clip.id, lane.targetDeviceId),
          field: lane.targetField,
          value: evalLaneAtBeat(lane.points, ctx, beat),
          combine: lane.combine ?? 'replace',
          magnitude: lane.magnitude ?? 'unsigned',
        });
      }
      if (track) pushTrackLanes(track);
      for (const read of clip.reads ?? []) {
        if (seenRail.has(read.railId)) continue;
        seenRail.add(read.railId);
        const rt = store.railTrackFor(read.railId);
        const base = rt?.baseCurve ? evalCurveAt(rt.baseCurve, totalBeats > 0 ? beat / totalBeats : 0) : 0;
        entries.push({
          instance: `rail_${read.railId}`, field: 'input', value: base,
          combine: 'replace', magnitude: 'unsigned',
        });
      }
    }
  };
  walk(store.compositeTreeAtBeat(beat, ignoreSolo));
  // The MAIN BUS isn't in the composite tree, but its master-FX chain DOES run over
  // the final composite (see buildCompositeRenderAtBeat), so emit its lanes too.
  const bus = store.mainBusTrack;
  if (bus && !bus.bypassed) pushTrackLanes(bus);
  return entries;
}
