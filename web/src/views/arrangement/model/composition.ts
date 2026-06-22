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

export interface Resolution {
  width: number;
  height: number;
}

/** Video playback modes, mirroring web/src/video/playhead-controllers.ts. */
export type PlayModeKind =
  | 'loop'
  | 'reverse-loop'
  | 'pingpong'
  | 'random-jumps'
  | 'hold';

/** Precise always waits (M1 focus + offline render). Live is future. */
export type TransportMode = 'precise' | 'live';

export interface CompositionMeta {
  resolution: Resolution;
  baseBPM: number;
  /** [beats per bar, beat unit] e.g. [4, 4]. */
  timeSignature: [number, number];
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

/** Lightweight sketch (device list) hosted by a clip or track. */
export interface ClipSketch {
  devices: Device[];
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

export interface ClipLoopConfig {
  mode: PlayModeKind;
  /** Source in/out frames consumed by the play-mode timing (video clips). */
  inFrame?: number;
  outFrame?: number;
  speed?: number;
}

export type ClipKind = 'effect' | 'video';

export interface Clip {
  id: string;
  name: string;
  startBeat: number;
  lengthBeat: number;
  /** Promoted from 'effect' to 'video' when a source/generator device is added. */
  kind: ClipKind;
  sketch: ClipSketch;
  /** Present iff kind === 'video' (display-only ref for the mockup). */
  source?: { label: string; durationFrames: number };
  loop: ClipLoopConfig;
  automation: AutomationLane[];
  exports: RailExport[];
  /** Modulations this clip reads from rails. */
  reads?: RailRead[];
  warps: WarpBinding[];
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
  /** For kind 'rail': the rail this track visualizes. */
  railId?: string;
  /** For kind 'rail': the base value envelope (automation), points x,y in [0,1]. */
  baseCurve?: EnvelopePoint[];
}

export interface PlayModeConfig {
  defaultMode: PlayModeKind;
}

export interface Composition {
  meta: CompositionMeta;
  /** Ordered; groups precede/contain their children by parentId. */
  tracks: Track[];
  rails: Rail[];
  playMode: PlayModeConfig;
}

/** A blank composition — the seed for a freshly created arrangement file. */
export function emptyComposition(): Composition {
  return {
    meta: {
      resolution: { width: 1920, height: 1080 },
      baseBPM: 120,
      timeSignature: [4, 4],
    },
    tracks: [],
    rails: [],
    playMode: { defaultMode: 'loop' },
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
