/**
 * instance-keys — the arrangement's engine-instance-key contract + the composite
 * tree node shape (`store.compositeTreeAtBeat`'s return type).
 *
 * The key strings are a LOCK-STEP contract with the native builder
 * (`native/src/sketch/comp/sketch_build.h`), pinned by the frozen build goldens
 * (`native/tests/fixtures/comp/build/*.json`, replayed by test_comp_build). The
 * comp executor keys every chain entry with these; engine telemetry
 * (pluginStates / modulationData) and the video decode pump address instances by
 * them — a drift means injected frames and read-back state go nowhere.
 */

import type { Clip, Track, GroupInput } from '../model/composition';

/**
 * The engine instance key a clip's device renders under. Engine telemetry
 * (pluginStates / modulationData) is keyed by this, so any reader mapping a
 * device back to its live engine state MUST go through here to stay in lock-step
 * with the native builder.
 */
export function clipInstanceKey(clipId: string, suffix: string): string {
  return `clip_${clipId}_${suffix}`;
}

/**
 * The engine instance key a TRACK-level device renders under. Keyed per TRACK
 * (not per clip), so a track's effect chain is ONE stable instance shared across
 * whichever clip is active on the track — its state + automation persist as the
 * active clip changes. Track automation targets these keys.
 */
export function trackInstanceKey(trackId: string, suffix: string): string {
  return `track_${trackId}_${suffix}`;
}

/** One clip LEAF to fold into the composite (clip + own opacity + blend). A plain
 *  object with no `type` (the legacy flat-layer shape) IS a clip leaf, so callers
 *  that pass a flat array of these still composite exactly as before. */
export interface CompositeClipNode {
  type?: 'clip';
  clip: Clip;
  /** Own composite opacity (relative to the immediate parent — NOT ancestor-multiplied;
   *  the recursion folds in ancestor group opacity via each group's own blend-up). */
  opacity: number;
  /** composite.blend mode for a source clip (0 = Normal/over). */
  blendMode?: number;
  /** The owning track — its `sketch` effect chain runs over the clip output (a
   *  per-track FX bus), keyed `track_<id>_<dev>` so track automation can target it. */
  track?: Track;
}

/** A GROUP node: its children composite into a sub-image (over the group's `input`
 *  base), the group's own `sketch` FX chain runs over that, and the result composites
 *  up into the parent (group blend mode + own opacity). Group FX is keyed per-group
 *  (`track_<groupId>_<dev>`) so group automation lanes can target it, exactly like a
 *  track FX bus. */
export interface CompositeGroupNode {
  type: 'group';
  group: Track;
  /** Own composite opacity (group level), applied as the group composites up. */
  opacity: number;
  blendMode?: number;
  /** The group's compositing input (what its children draw over). */
  input: GroupInput;
  children: CompositeNode[];
}

export type CompositeNode = CompositeClipNode | CompositeGroupNode;
