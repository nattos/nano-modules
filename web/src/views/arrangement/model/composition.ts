/**
 * Nano Arrangement — core data model (Milestone 1: mockup).
 *
 * This is the *real* `Composition` shape from the PRD. In M1 it is populated
 * with fake data (see `fake-data.ts`) and never crosses to a worker; later
 * milestones serialize it (sanitized via JSON.parse(JSON.stringify(toJS(...))))
 * to the timeline-native worker.
 *
 * All timings are in **beats** (double). A clip *is* a sketch host — for the
 * mockup the sketch is represented by a lightweight `ClipSketch` (a device
 * list) that maps onto a real Structor `Sketch` (ChainEntry[]) in M2+.
 */

import type { Wire as SketchWire } from '../../../sketch-types';

export interface Resolution {
  width: number;
  height: number;
}

/**
 * How a video clip's source SLICE ([startSec,endSec] in neutral-speed seconds)
 * maps onto the clip's beat span on the timeline:
 *  - one-shot:  play once from startSec at `speed`; never loops. The end-into-source
 *               is a free variable (clip length × BPM × speed). Off the source ends
 *               (before 0 / past the file) ⇒ transparent.
 *  - time:      loop the slice; the loop count follows clip length × BPM (warp-aware).
 *  - beat-sync: loop the slice locked to `syncBeats` beats per loop — count follows
 *               clip length but NOT BPM; the playback speed floats with tempo instead.
 *  - random:    dwell on a source point for a (jittered) `dwell`, then jump (anywhere in
 *               a ±distance sampled in [jumpDistanceMin, jumpDistanceMax]). Stochastic at playback; the
 *               film strips show a deterministic smooth-noise approximation instead.
 */
export type ClipPlayMode = 'one-shot' | 'time' | 'beat-sync' | 'random';

/** Playback direction through the slice. Looping modes can also ping-pong. */
export type PlayDirection = 'forward' | 'reverse';

/** Precise always waits (M1 focus + offline render). Live is future. */
export type TransportMode = 'precise' | 'live';

/**
 * How a video/image frame scales into the output canvas:
 *  - fit:     contain (preserve aspect, letterbox the remainder transparently)
 *  - cover:   fill (preserve aspect, crop the overflow)
 *  - stretch: fill (ignore aspect)
 *  - none:    1:1 pixels, centred (crop if larger, pad if smaller)
 */
export type ScaleMode = 'fit' | 'cover' | 'stretch' | 'none';

/**
 * Composite blend mode names, indexed to match the native `composite.blend`
 * (video_blend) enum exactly — the index IS the mode value sent to the executor.
 * Keep in lock-step with native/wasm_modules/video_blend/main.cpp.
 */
export const BLEND_MODE_NAMES = [
  'Normal', 'Add', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'Dodge', 'Burn', 'Hard Light', 'Soft Light', 'Difference', 'Exclusion',
  'Subtract', 'Divide', 'Linear Burn',
] as const;

/** Quarter-turn rotations applied to a clip's source frame, clockwise degrees. */
export type SourceRotation = 0 | 90 | 180 | 270;

/**
 * Placement transform for a clip's source frame within the output canvas, applied
 * ON TOP of the base `scaleMode` fit. All optional — the omitted/default transform
 * is a centred, unscaled, unrotated, unflipped frame.
 *
 *  - anchorX/anchorY ∈ [0,1]: alignment of the (scaled) frame within the canvas.
 *    X: 0 = left edges aligned, 1 = right edges aligned, 0.5 = centres. Y likewise
 *    (0 = tops). The same formula `offset = anchor·(canvas − frame)` covers both the
 *    letterbox regime (frame smaller ⇒ moves inside) and the crop regime (frame
 *    larger ⇒ pans the visible window).
 *  - scale: extra zoom about the frame's own centre (default 1). Lets a source
 *    larger than the canvas be shown at a higher resolution than 'fit' would.
 *  - rotation: 0/90/180/270 quarter turns.
 *  - flipH/flipV: mirror across the vertical / horizontal axis.
 */
export interface SourceTransform {
  anchorX: number;
  anchorY: number;
  scale: number;
  rotation: SourceRotation;
  flipH: boolean;
  flipV: boolean;
}

export const DEFAULT_SOURCE_TRANSFORM: SourceTransform = {
  anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false,
};

/** Fill the transform with defaults for any omitted field (read-side helper). */
export function resolveSourceTransform(t?: Partial<SourceTransform>): SourceTransform {
  return {
    anchorX: t?.anchorX ?? 0.5,
    anchorY: t?.anchorY ?? 0.5,
    scale: t?.scale ?? 1,
    rotation: t?.rotation ?? 0,
    flipH: t?.flipH ?? false,
    flipV: t?.flipV ?? false,
  };
}

/** The composite's backdrop, under all clips. Default (omitted) = opaque black. */
export interface BackgroundConfig {
  mode: 'black' | 'transparent' | 'custom';
  /** CSS color for `custom` mode (e.g. '#1a2b3c'). */
  color?: string;
}

export interface CompositionMeta {
  resolution: Resolution;
  baseBPM: number;
  /** [beats per bar, beat unit] e.g. [4, 4]. */
  timeSignature: [number, number];
  /** Composite backdrop (under all clips). Omitted ⇒ opaque black. */
  background?: BackgroundConfig;
  /** Render/export frame rate (frames per second). Omitted ⇒ {@link DEFAULT_FPS}. */
  fps?: number;
  /** Persisted export/render settings (resolution mode, quality, range). */
  export?: ExportSettings;
}

/** Default render/export frame rate when the composition doesn't set one. */
export const DEFAULT_FPS = 60;

/** The composition's render/export frame rate (with the default applied). */
export function compositionFps(comp: Composition): number {
  const f = comp.meta.fps;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : DEFAULT_FPS;
}

/** How the export's pixel dimensions derive from the composition resolution. */
export type ExportResolutionMode = 'default' | '2x' | 'scale' | 'custom';
/** Whether the export uses the composition frame rate or a custom override. */
export type ExportFpsMode = 'default' | 'custom';
/** H.264 quality tier (→ a bits-per-pixel budget in the exporter). */
export type ExportQuality = 'low' | 'medium' | 'high';
/** Which beat span to export. */
export type ExportRangeKind = 'all' | 'loop';

/** Persisted export/render settings (saved on the composition's `meta.export`). */
export interface ExportSettings {
  resolutionMode: ExportResolutionMode;
  /** Multiplier for `scale` mode (× composition resolution). */
  scale: number;
  /** Explicit pixel dimensions for `custom` mode. */
  width: number;
  height: number;
  /** Frame-rate source: the composition's fps, or a custom override below. */
  fpsMode: ExportFpsMode;
  /** Custom export frame rate (used when `fpsMode === 'custom'`). */
  fps: number;
  quality: ExportQuality;
  range: ExportRangeKind;
  /** Export the full mix, ignoring any soloed-track restriction. */
  ignoreSolo: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolutionMode: 'default', scale: 1, width: 1920, height: 1080,
  fpsMode: 'default', fps: 60, quality: 'high', range: 'all', ignoreSolo: false,
};

/** The composition's export settings, with defaults filled in for missing fields. */
export function exportSettings(comp: Composition): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...(comp.meta.export ?? {}) };
}

/** Effective export pixel dimensions from the resolution mode + composition resolution. */
export function exportResolution(comp: Composition): { width: number; height: number } {
  const r = comp.meta.resolution;
  const s = exportSettings(comp);
  switch (s.resolutionMode) {
    case '2x': return { width: r.width * 2, height: r.height * 2 };
    case 'scale': return { width: Math.round(r.width * s.scale), height: Math.round(r.height * s.scale) };
    case 'custom': return { width: s.width, height: s.height };
    default: return { width: r.width, height: r.height };
  }
}

/** Effective export frame rate: the composition's fps, or a custom override. */
export function exportFps(comp: Composition): number {
  const s = exportSettings(comp);
  return s.fpsMode === 'custom' && s.fps > 0 ? Math.round(s.fps) : compositionFps(comp);
}

/**
 * Capability tags carried by a device, mirroring the engine's capability
 * taxonomy (host.h). The only distinction M1 needs is whether a device
 * *processes textures* vs. is *modulation-only* — see `deviceProcessesTexture`.
 */
export type DeviceCapability =
  | 'source'
  | 'generator'
  | 'time_independent'
  | 'modulation_source'
  | 'modulation_source_single'
  | 'modulation_source_multi'
  | 'modulation_shaper'
  | 'modulation_shaper_unary'
  | 'offline_renderable';

/** One effect in a clip/track sketch (maps to a ChainEntry in M2+). */
export interface Device {
  id: string;
  /** Dotted module id, e.g. "color.saturate" or "mod.lfo". */
  moduleType: string;
  name: string;
  capabilities: DeviceCapability[];
  /** Inspector-editable field values (opaque for the mockup). */
  state?: Record<string, unknown>;
}

const MODULATION_ONLY_CAPS = new Set<DeviceCapability>([
  'modulation_source',
  'modulation_source_single',
  'modulation_source_multi',
  'modulation_shaper',
  'modulation_shaper_unary',
  'offline_renderable',
]);

/**
 * A device processes texture frames unless *every* capability it carries is a
 * modulation capability (and it carries at least one). A device with no
 * capabilities is treated as a frame processor (a plain effect).
 */
export function deviceProcessesTexture(device: Device): boolean {
  if (device.capabilities.length === 0) return true;
  return !device.capabilities.every((c) => MODULATION_ONLY_CAPS.has(c));
}

export function deviceIsSource(device: Device): boolean {
  return (
    device.capabilities.includes('source') ||
    device.capabilities.includes('generator')
  );
}

/** Lightweight sketch (device list + intra-sketch modulation wires) hosted by a
 *  clip or track. Wires connect a producer field (`src`) to a destination param
 *  (`dest`) by device id; the same `Wire` shape as the engine sketch so the
 *  <column-group> overlay can render them. (Rail/return endpoints will extend
 *  this later — punted for now.) */
export interface ClipSketch {
  devices: Device[];
  wires?: SketchWire[];
}

/** A point in an automation/envelope lane: x in [0,1] of lane span, y in [0,1]. */
export interface EnvelopePoint {
  x: number;
  y: number;
  /** Easing bend of the segment leaving this point, -1..1 (0 = linear). */
  bend?: number;
}

/** Track-level or clip-level automation of one field. */
export interface AutomationLane {
  id: string;
  /** Field targeted within the owning sketch (device + field path). */
  targetDeviceId: string;
  targetField: string;
  label: string;
  points: EnvelopePoint[];
  /** Collapsed in the UI by default. */
  expanded?: boolean;
  /** How the curve folds into the target field (shared with the wire/tap_mod
   *  vocab). Default 'replace' — the curve drives the param across its range. */
  combine?: RailCombine;
  /** Polarity of the normalized curve when mapped into the field's range.
   *  Default 'unsigned' (0→min, 1→max). */
  magnitude?: RailMagnitude;
}

/** A value-only return channel. range = its modulation contract. */
export interface Rail {
  id: string;
  name: string;
  defaultValue: number;
  range: { min: number; max: number };
}

/** Combine modes shared with the wire system (tap_mod). */
export type RailCombine = 'replace' | 'mix' | 'add' | 'mul';
export type RailMagnitude = 'auto' | 'signed' | 'unsigned' | 'absolute';

/** Tap options shared by rail reads/writes (mirrors the wire tap_mod options). */
export interface RailTap {
  scale?: number;
  smoothing?: boolean;
  remap?: boolean;
}

/** A modulation this clip writes onto a rail (read/written like a wire). */
export interface RailExport extends RailTap {
  id: string;
  railId: string;
  sourceDeviceId: string;
  sourceField: string;
  combine: RailCombine;
  magnitude: RailMagnitude;
}

/** A modulation this clip reads FROM a rail into one of its fields (like a wire). */
export interface RailRead extends RailTap {
  id: string;
  railId: string;
  targetDeviceId: string;
  targetField: string;
  combine: RailCombine;
  magnitude: RailMagnitude;
}

/** A device in this clip that warps the beat grid over the clip's range. */
export interface WarpBinding {
  id: string;
  sourceDeviceId: string;
  /** v1: only deterministic LFO waveforms are precomputable. */
  waveform: 'sine' | 'square' | 'triangle' | 'saw';
  /** Tempo deviation amplitude, 0..1 (fraction of nominal tempo). */
  amplitude: number;
  /** Warp period in beats. */
  periodBeats: number;
  /** Phase offset 0..1. */
  phase: number;
}

/**
 * A video clip's playback timing. The source SLICE is [startSec, endSec] measured in
 * the file's own (neutral-speed) seconds; `mode` decides how that slice maps onto the
 * clip's beat span. See {@link ClipPlayMode} and engine/clip-time.ts (the read-side
 * beat→source-time mapper).
 */
export interface ClipLoopConfig {
  mode: ClipPlayMode;
  /** Slice start into the source, neutral-speed seconds. May be < 0 (one-shot ⇒
   *  transparent before the file start). */
  startSec: number;
  /** Slice end into the source, seconds. Used by time/beat-sync/random; one-shot
   *  ignores it (its end-into-source free-floats with clip length). */
  endSec?: number;
  /** Looping modes: where playback BEGINS at the clip's left edge, in source seconds
   *  (Ableton's "Start" marker). May sit before `startSec` (a pre-roll played once
   *  before the loop kicks in) but generally not after `endSec`. Omitted ⇒ `startSec`.
   *  Trimming the left edge adjusts this so the loop boundaries stay fixed in time. */
  playStartSec?: number;
  /** Playback speed scale factor (default 1). Ignored by beat-sync (speed is implied
   *  by the beat lock). */
  speed: number;
  /** forward | reverse through the slice. */
  direction: PlayDirection;
  /** Looping modes: reflect at the slice ends (anchored so the slice start is the ping). */
  pingpong?: boolean;
  /** beat-sync: the slice's duration in beats — one loop spans this many beats. */
  syncBeats?: number;
  /** beat-sync alt: a 'natural' clip BPM; the slice's beats are derived from its
   *  seconds + this (instead of `syncBeats`). */
  syncBpm?: number;
  /** beat-sync sub-mode: use `syncBpm` instead of `syncBeats`. */
  syncUseBpm?: boolean;
  /** random: how long to hold a source position before jumping (default 1). */
  dwell?: number;
  /** random: units for `dwell` — 'beat' (default) or 'sec'. */
  dwellUnit?: 'sec' | 'beat';
  /** random: 0..1, fraction of each dwell that's randomized (0 = exact, 1 = ±100%). */
  dwellJitter?: number;
  /** random: min/max jump distance from the current position. Each jump samples a
   *  distance uniformly in [min, max] (then a random ± direction). Interpreted per
   *  {@link jumpDistanceUnit}. */
  jumpDistanceMin?: number;
  jumpDistanceMax?: number;
  /** random: units for the jump distance — 'fraction' of the slice (default) or 'sec'. */
  jumpDistanceUnit?: 'fraction' | 'sec';
}

/** Fallback random params (used when a field is unset; keeps non-random clips clean).
 *  Random also reads `speed` (default 1) — playback progresses through the source at
 *  `speed` between jumps, looping at the slice end. */
export const RANDOM_DEFAULTS = {
  dwell: 1,
  dwellUnit: 'beat' as const,
  dwellJitter: 0.3,
  jumpDistanceMin: 0,
  jumpDistanceMax: 1,
  jumpDistanceUnit: 'fraction' as const,
};

export type ClipKind = 'effect' | 'video';

export interface Clip {
  id: string;
  name: string;
  startBeat: number;
  lengthBeat: number;
  /** Promoted from 'effect' to 'video' when a source/generator device is added. */
  kind: ClipKind;
  sketch: ClipSketch;
  /**
   * Present iff kind === 'video'. `label` + `durationFrames` are display-only;
   * the optional media ref (`sourceKey` + `url` + `fps`) links real on-disk
   * media so the film strip shows decoded thumbnails (Component D). Absent ⇒
   * the procedural reel stand-in.
   */
  source?: {
    label: string;
    durationFrames: number;
    /** Stable cache identity (a file change should change this). */
    sourceKey?: string;
    /** Fetchable URL of the media (served asset / object URL). */
    url?: string;
    fps?: number;
    /** Native pixel dimensions (aspect for the placement widget). 0/absent ⇒ unknown. */
    width?: number;
    height?: number;
    /** How the frame is scaled into the output canvas. Omitted ⇒ 'fit'. */
    scaleMode?: ScaleMode;
    /** Placement transform (anchor / scale / rotation / flip) layered on the base
     *  scaleMode fit. Omitted fields default per {@link resolveSourceTransform}. */
    transform?: Partial<SourceTransform>;
  };
  loop: ClipLoopConfig;
  automation: AutomationLane[];
  exports: RailExport[];
  /** Modulations this clip reads from rails. */
  reads?: RailRead[];
  warps: WarpBinding[];
  /**
   * Composite blend mode for a SOURCE clip (a clip with a generator at the top
   * of its chain) when it's layered over the tracks above it — the `composite.blend`
   * mode index (0 = Normal/over). Omitted ⇒ Normal. Effect-only clips ignore it
   * (they process the composite below them inline).
   */
  blendMode?: number;
  /** Bypassed clips are skipped in the composite (the "0" shortcut toggles it). */
  bypassed?: boolean;
}

export type TrackKind = 'track' | 'group' | 'rail';

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Group nesting; groups sum their children upward. */
  parentId: string | null;
  /** Track/group-level effect chain. */
  sketch: ClipSketch;
  /** Track-level automation (targets THIS track's sketch only). */
  automation: AutomationLane[];
  /** Clips (tracks only; groups have none). */
  clips: Clip[];
  /** Collapsed group in the UI. */
  collapsed?: boolean;
  /** Lane color accent (category-style). */
  color?: string;
  /** Soloed (only soloed tracks audition). Mockup: visual only. */
  soloed?: boolean;
  /** Bypassed/disabled (the track activator). Mockup: visual only. */
  bypassed?: boolean;
  /** Mixer output level / opacity into the bus, 0..1 (default ~0.85). */
  level?: number;
  /** Composite blend mode for this track's clips, layered over the tracks above —
   *  a {@link BLEND_MODE_NAMES} index (0 = Normal). Omitted ⇒ Normal. */
  blendMode?: number;
  /** For kind 'rail': the rail this track visualizes. */
  railId?: string;
  /** For kind 'rail': the base value envelope (automation), points x,y in [0,1]. */
  baseCurve?: EnvelopePoint[];
  /** For kind 'rail': SIGNED (bipolar −1..1, summed around 0) vs UNSIGNED (0..1). Sets
   *  how writer wires fold AND the lane's display range. Omitted ⇒ unsigned (most
   *  modulation sources are unsigned, and the default combine is add). */
  railSigned?: boolean;
}

export interface PlayModeConfig {
  defaultMode: ClipPlayMode;
}

export interface Composition {
  meta: CompositionMeta;
  /** Ordered; groups precede/contain their children by parentId. */
  tracks: Track[];
  rails: Rail[];
  playMode: PlayModeConfig;
  /**
   * Persisted loop markers (transport loop brace). Saved with the document but
   * NEVER goes through undo/redo — it's written directly + flushed like a
   * preference. Omitted on legacy files ⇒ the store keeps its defaults
   * (enabled, [0, 32]).
   */
  loop?: { enabled: boolean; startBeat: number; endBeat: number };
}

/** The master/main-bus track — a root group every track sums into. It's the one
 *  mandatory track; the store ensures it exists and never lets it be deleted or
 *  reordered (it always pins to the bottom). */
export function makeMainBus(): Track {
  return {
    id: 'main-bus',
    name: 'Main Bus',
    kind: 'group',
    parentId: null,
    color: 'var(--app-cat-composite)',
    sketch: { devices: [] },
    automation: [],
    clips: [],
  };
}

/** The default playback timing for a new clip (looping `time` mode over the whole
 *  source). `videoDurSec` sets the slice end when the media duration is known. */
export function defaultClipLoop(videoDurSec?: number): ClipLoopConfig {
  return {
    mode: 'time',
    startSec: 0,
    endSec: videoDurSec && videoDurSec > 0 ? videoDurSec : undefined,
    speed: 1,
    direction: 'forward',
  };
}

/** A blank composition — the seed for a freshly created arrangement file. */
export function emptyComposition(): Composition {
  return {
    meta: {
      resolution: { width: 1920, height: 1080 },
      baseBPM: 120,
      timeSignature: [4, 4],
      fps: DEFAULT_FPS,
    },
    tracks: [makeMainBus()],
    rails: [],
    playMode: { defaultMode: 'time' },
  };
}

/**
 * Effective warp segments derived from every clip's warp bindings. Each binding
 * contributes a sinusoidal tempo deviation over its clip's [start, end] range.
 * The beat-grid transform integrates these to place grid lines (Innovation 1).
 */
export interface WarpSegment {
  startBeat: number;
  endBeat: number;
  waveform: WarpBinding['waveform'];
  amplitude: number;
  periodBeats: number;
  phase: number;
}

export function derivedWarpSegments(comp: Composition): WarpSegment[] {
  const segs: WarpSegment[] = [];
  for (const track of comp.tracks) {
    for (const clip of track.clips) {
      for (const w of clip.warps) {
        segs.push({
          startBeat: clip.startBeat,
          endBeat: clip.startBeat + clip.lengthBeat,
          waveform: w.waveform,
          amplitude: w.amplitude,
          periodBeats: w.periodBeats,
          phase: w.phase,
        });
      }
    }
  }
  return segs;
}

/** Does this clip process texture frames (insert) vs. modulation-only? */
export function clipProcessesTexture(clip: Clip): boolean {
  return clip.sketch.devices.some(deviceProcessesTexture);
}

/** Total beats spanned by the composition (for ruler extent), min 64. */
export function compositionLengthBeats(comp: Composition): number {
  let end = 64;
  for (const t of comp.tracks) {
    for (const c of t.clips) {
      end = Math.max(end, c.startBeat + c.lengthBeat);
    }
  }
  return end;
}
