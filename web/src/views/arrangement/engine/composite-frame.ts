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
import { buildCompositeSketch, clipInstanceKey, trackInstanceKey } from './clip-sketch';
import { evalLaneAtBeat, evalCurveAt } from './automation-eval';
import { makeWarpClock } from './warp-clock';
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

/** Per-rail base value + signed flag at `beat` (the return track's contract). */
function railBasesAtBeat(layers: EngineLayer[], beat: number): {
  railBases: Map<string, number>;
  railSigned: Map<string, boolean>;
} {
  const totalBeats = compositionLengthBeats(store.composition);
  const railBases = new Map<string, number>();
  const railSigned = new Map<string, boolean>();
  for (const l of layers) {
    for (const read of l.clip.reads ?? []) {
      if (railBases.has(read.railId)) continue;
      const rt = store.railTrackFor(read.railId);
      railBases.set(read.railId, rt?.baseCurve ? evalCurveAt(rt.baseCurve, totalBeats > 0 ? beat / totalBeats : 0) : 0);
      railSigned.set(read.railId, rt?.railSigned ?? false);
    }
  }
  return { railBases, railSigned };
}

/**
 * Fold the active engine `layers` into ONE composite sketch at `beat` — rail
 * base-curve values and each clip's absolute start-seconds baked in (warp-aware).
 * Returns null when no layer contributes (the caller renders the backdrop). The
 * `sig` lets a caller re-issue to the engine only when the composite changes.
 */
export function buildCompositeRenderAtBeat(layers: EngineLayer[], beat: number) {
  if (layers.length === 0) return null;
  const { railBases, railSigned } = railBasesAtBeat(layers, beat);
  const clock = makeWarpClock(store.composition);
  return buildCompositeSketch(
    layers.map((l) => ({
      clip: l.clip,
      opacity: l.opacity ?? 1,
      blendMode: l.blendMode,
      track: l.track,
      startSec: clock.secondsAt(l.clip.startBeat),
    })),
    store.composition.meta.background,
    railBases,
    railSigned,
  );
}

/**
 * Evaluate this beat's parameter automation: every active CLIP lane (clip-relative
 * beats) and TRACK lane (absolute beats), plus a `replace` re-assertion of each
 * active rail's base value onto its accumulator `input` (so a dropped writer wire
 * resets the rail to base instead of holding the last modulated value). The
 * executor folds each entry into its target field via tap_mod.
 */
export function automationEntriesAtBeat(beat: number): AutomationEntry[] {
  const totalBeats = compositionLengthBeats(store.composition);
  const entries: AutomationEntry[] = [];
  const seenRail = new Set<string>();
  for (const { clip, track } of store.compositeLayersAtBeat(beat)) {
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
    for (const lane of track.automation ?? []) {
      entries.push({
        instance: trackInstanceKey(track.id, lane.targetDeviceId),
        field: lane.targetField,
        value: evalLaneAtBeat(lane.points, { kind: 'track' }, beat),
        combine: lane.combine ?? 'replace',
        magnitude: lane.magnitude ?? 'unsigned',
      });
    }
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
  return entries;
}
