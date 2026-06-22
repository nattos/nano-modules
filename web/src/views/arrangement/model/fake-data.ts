/**
 * Fake composition for the Milestone 1 mockup. Exercises every surface:
 * groups, effect + video clips, modulation-only clips, automation (track &
 * clip), rails/returns, and a beat warp.
 */

import type {
  Composition,
  Device,
  DeviceCapability,
  Clip,
  Track,
  AutomationLane,
} from './composition';

let _id = 0;
const uid = (prefix: string) => `${prefix}_${(_id++).toString(36)}`;

function device(
  moduleType: string,
  name: string,
  capabilities: DeviceCapability[] = [],
): Device {
  return { id: uid('dev'), moduleType, name, capabilities };
}

function envLane(
  label: string,
  targetField: string,
  targetDeviceId: string,
  points: Array<[number, number]>,
  expanded = false,
): AutomationLane {
  return {
    id: uid('auto'),
    targetDeviceId,
    targetField,
    label,
    expanded,
    points: points.map(([x, y]) => ({ x, y })),
  };
}

export function makeFakeComposition(): Composition {
  // ── A video clip: source + color devices ──────────────────────────────
  const srcDev = device('source.video.file', 'Clip A.mov', ['source']);
  const satDev = device('color.saturate', 'Saturate', ['time_independent']);
  const videoClipA: Clip = {
    id: uid('clip'),
    name: 'Intro Plate',
    startBeat: 0,
    lengthBeat: 16,
    kind: 'video',
    source: { label: 'Clip A.mov', durationFrames: 480 },
    sketch: { devices: [srcDev, satDev] },
    loop: { mode: 'loop', inFrame: 0, outFrame: 480, speed: 1 },
    automation: [
      envLane('Saturate · amount', 'amount', satDev.id, [
        [0, 0.3],
        [0.5, 0.9],
        [1, 0.5],
      ]),
    ],
    exports: [],
    reads: [
      {
        id: uid('read'),
        railId: 'rail_pulse',
        targetDeviceId: satDev.id,
        targetField: 'amount',
        combine: 'add',
        magnitude: 'unsigned',
      },
    ],
    warps: [],
  };

  // ── A second video clip on the same track, random-jumps mode ──────────
  const srcDev2 = device('source.video.file', 'Clip B.mov', ['source']);
  const blurDev = device('filter.blur.gaussian', 'Gaussian Blur', [
    'time_independent',
  ]);
  const videoClipB: Clip = {
    id: uid('clip'),
    name: 'Glitch Hit',
    startBeat: 20,
    lengthBeat: 12,
    kind: 'video',
    source: { label: 'Clip B.mov', durationFrames: 300 },
    sketch: { devices: [srcDev2, blurDev] },
    loop: { mode: 'random-jumps', inFrame: 0, outFrame: 300, speed: 1 },
    automation: [],
    exports: [],
    reads: [
      {
        id: uid('read'),
        railId: 'rail_sweep',
        targetDeviceId: blurDev.id,
        targetField: 'radius',
        combine: 'mix',
        magnitude: 'signed',
      },
    ],
    warps: [],
  };

  // ── An effect-only (texture-processing insert) clip ───────────────────
  const warpDev = device('warp.displace', 'Displace', ['time_independent']);
  const effectClip: Clip = {
    id: uid('clip'),
    name: 'Displace Insert',
    startBeat: 8,
    lengthBeat: 10,
    kind: 'effect',
    sketch: { devices: [warpDev] },
    loop: { mode: 'hold' },
    automation: [],
    exports: [],
    warps: [],
  };

  // ── A modulation-only clip that exports an LFO to a rail AND warps the
  //    beat grid (Innovation 1 + 2) ──────────────────────────────────────
  const lfoDev = device('mod.lfo', 'LFO', [
    'modulation_source',
    'modulation_source_single',
    'offline_renderable',
  ]);
  const modClip: Clip = {
    id: uid('clip'),
    name: 'Pulse → Rail / Warp',
    startBeat: 4,
    lengthBeat: 24,
    kind: 'effect',
    sketch: { devices: [lfoDev] },
    loop: { mode: 'loop' },
    automation: [],
    exports: [
      {
        id: uid('exp'),
        railId: 'rail_pulse',
        sourceDeviceId: lfoDev.id,
        sourceField: 'output',
        combine: 'replace',
        magnitude: 'unsigned',
      },
      {
        id: uid('exp'),
        railId: 'rail_sweep',
        sourceDeviceId: lfoDev.id,
        sourceField: 'output2',
        combine: 'replace',
        magnitude: 'signed',
      },
    ],
    warps: [
      {
        id: uid('warp'),
        sourceDeviceId: lfoDev.id,
        waveform: 'sine',
        amplitude: 0.45,
        periodBeats: 8,
        phase: 0,
      },
    ],
  };

  // ── Tracks ────────────────────────────────────────────────────────────
  const bloomDev = device('composite.bloom', 'Bloom', ['time_independent']);
  const videoTrack: Track = {
    id: uid('trk'),
    name: 'Footage',
    kind: 'track',
    parentId: null,
    color: 'var(--app-cat-source)',
    sketch: { devices: [bloomDev] },
    automation: [
      envLane('Bloom · intensity', 'intensity', bloomDev.id, [
        [0, 0.2],
        [0.4, 0.8],
        [1, 0.4],
      ]),
    ],
    clips: [videoClipA, videoClipB, effectClip],
  };

  const modTrack: Track = {
    id: uid('trk'),
    name: 'Modulators',
    kind: 'track',
    parentId: null,
    color: 'var(--app-cat-mod)',
    sketch: { devices: [] },
    automation: [],
    clips: [modClip],
  };

  // ── Rail (return) tracks — value-only channels. Behave like normal tracks
  //    (movable), shown as an envelope. ──────────────────────────────────────
  const railPulse: Track = {
    id: uid('trk'),
    name: 'Pulse',
    kind: 'rail',
    parentId: null,
    color: 'var(--app-cat-mod)',
    sketch: { devices: [] },
    automation: [],
    clips: [],
    railId: 'rail_pulse',
    baseCurve: [
      { x: 0, y: 0.18 },
      { x: 0.45, y: 0.4 },
      { x: 1, y: 0.22 },
    ],
  };
  const railSweep: Track = {
    id: uid('trk'),
    name: 'Sweep',
    kind: 'rail',
    parentId: null,
    color: 'var(--app-io-output)',
    sketch: { devices: [] },
    automation: [],
    clips: [],
    railId: 'rail_sweep',
    baseCurve: [
      { x: 0, y: 0.5 },
      { x: 0.6, y: 0.62 },
      { x: 1, y: 0.45 },
    ],
  };

  // ── The main bus / master — pinned to the bottom (Ableton-style). All
  //    tracks sum into it. ────────────────────────────────────────────────
  const groupTrack: Track = {
    id: uid('trk'),
    name: 'Main Bus',
    kind: 'group',
    parentId: null,
    color: 'var(--app-cat-composite)',
    sketch: {
      devices: [
        device('composite.grade', 'Color Grade', ['time_independent']),
        device('color.lut', 'Film LUT', ['time_independent']),
      ],
    },
    automation: [],
    clips: [],
  };

  return {
    meta: {
      resolution: { width: 1920, height: 1080 },
      baseBPM: 120,
      timeSignature: [4, 4],
    },
    // Non-bus tracks render top-to-bottom; the main bus pins to the bottom.
    // Rail tracks sit just above the bus but are freely movable.
    tracks: [groupTrack, videoTrack, modTrack, railPulse, railSweep],
    rails: [
      { id: 'rail_pulse', name: 'Pulse', defaultValue: 0, range: { min: 0, max: 1 } },
      { id: 'rail_sweep', name: 'Sweep', defaultValue: 0.5, range: { min: -1, max: 1 } },
    ],
    playMode: { defaultMode: 'loop' },
  };
}
