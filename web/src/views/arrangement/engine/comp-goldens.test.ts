/**
 * comp-goldens.test.ts — shared golden fixtures for the C++ composition
 * executor's Phase-A ports (warp_curve.h, clip_time.h, comp_transport.h,
 * precise_gate.h in native/src/sketch/comp/).
 *
 * TS is the REFERENCE implementation during the port: with UPDATE_GOLDENS=1
 * this suite regenerates native/tests/fixtures/comp/*.json from the TS code;
 * without it, it verifies the TS code still reproduces the committed fixtures
 * (so TS drift is caught until the TS twins are deleted). The Catch2 twin
 * (native/tests/test_comp_time.cpp) replays the SAME fixtures against the C++
 * ports — that pair of suites IS the lock-step contract.
 *
 * Numeric parity note: everything here is IEEE-deterministic across JS/C++
 * (+,-,*,/,floor,fmod) EXCEPT Math.sin (warp waves, smooth noise), which may
 * differ from libm by ~1 ulp. Times compare within 1e-9; expected FRAMES are
 * only emitted when the source position is comfortably inside a frame (not
 * within 1e-6 of a floor boundary), so a 1-ulp time wobble can't flip them.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WarpCurve } from '../model/beat-grid';
import {
  makeMainBus,
  type WarpSegment, type ClipLoopConfig, type Composition, type Track, type Clip, type Device,
} from '../model/composition';
import { WarpClock } from './warp-clock';
import { clipSourceTimeAt, clipSourceFrameAt, clipNoiseSeed, type ClipTimeCtx } from './clip-time';
import { TransportController, type TransportState } from './transport-clock';
import { videoInputsReady, shouldHoldPrecise, pumpActiveSet } from './precise-gate';
import { buildCompositeRenderAtBeat, automationEntriesAtBeat } from './composite-frame';
import { seedTestPlugins, TEST_PLUGINS } from './test-plugins';
import { store } from '../state/store';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../native/tests/fixtures/comp',
);
const UPDATE = !!process.env.UPDATE_GOLDENS;

// ---------------------------------------------------------------------------
// Fixture I/O
// ---------------------------------------------------------------------------

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/** In UPDATE mode write `data` and pass; otherwise assert the file matches. */
function checkFixture(name: string, data: unknown) {
  const file = fixturePath(name);
  if (UPDATE) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
    return;
  }
  expect(fs.existsSync(file), `${name} missing — run UPDATE_GOLDENS=1 npx vitest run comp-goldens`).toBe(true);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(data).toEqual(stored);
}

// ---------------------------------------------------------------------------
// Shared spec helpers
// ---------------------------------------------------------------------------

interface ClockSpec {
  bpm: number;
  totalBeats: number;
  segments: WarpSegment[];
}

function makeClock(spec: ClockSpec): WarpClock {
  return new WarpClock(new WarpCurve(spec.segments, spec.totalBeats), spec.bpm);
}

const seg = (
  startBeat: number, endBeat: number, waveform: WarpSegment['waveform'],
  amplitude: number, periodBeats: number, phase: number,
): WarpSegment => ({ startBeat, endBeat, waveform, amplitude, periodBeats, phase });

/** Deterministic, boundary-avoiding beat samples across [lo, hi]. */
function sampleBeats(lo: number, hi: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(lo + ((hi - lo) * i) / (n - 1) + (i > 0 && i < n - 1 ? 0.0137 : 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// warp.json — WarpCurve.unitsAt/beatAt + WarpClock seconds mapping
// ---------------------------------------------------------------------------

const WARP_CLOCKS: Array<{ name: string } & ClockSpec> = [
  { name: 'flat-120', bpm: 120, totalBeats: 64, segments: [] },
  {
    name: 'sine-basic', bpm: 120, totalBeats: 64,
    segments: [seg(0, 16, 'sine', 0.4, 8, 0)],
  },
  {
    name: 'overlapping-multi', bpm: 90, totalBeats: 96,
    segments: [seg(0, 16, 'sine', 0.4, 8, 0), seg(8, 24, 'triangle', 0.3, 4, 0.25)],
  },
  {
    name: 'square-saw-clamped', bpm: 140, totalBeats: 64,
    // amplitudes big enough to hit the 0.15 tempo-multiplier clamp
    segments: [seg(4, 20, 'square', 0.95, 3, 0.5), seg(10, 30, 'saw', 0.7, 5, 0.9)],
  },
  {
    name: 'offset-segment', bpm: 60, totalBeats: 40,
    segments: [seg(24, 36, 'sine', 0.5, 6, 0.33)],
  },
];

function buildWarpFixture() {
  return {
    cases: WARP_CLOCKS.map((spec) => {
      const clock = makeClock(spec);
      const beats = [
        -2, -0.25, 0,
        ...sampleBeats(0.1, spec.totalBeats, 24),
        spec.totalBeats + 3.7, spec.totalBeats + 16, // extrapolation past the table
      ];
      const units = beats.map((b) => clock.curve.unitsAt(b));
      return {
        name: spec.name,
        bpm: spec.bpm,
        totalBeats: spec.totalBeats,
        segments: spec.segments,
        samples: beats.map((beat, i) => ({
          beat,
          units: units[i],
          seconds: clock.secondsAt(beat),
        })),
        // Inverse through the exact forward outputs (round-trip property).
        inverse: units.map((u, i) => ({ units: u, beat: clock.curve.beatAt(u) })),
        invSeconds: beats.map((b) => {
          const s = clock.secondsAt(b);
          return { seconds: s, beat: clock.beatAtSeconds(s) };
        }),
        local: sampleBeats(0.5, spec.totalBeats - 0.5, 8).map((beat) => ({
          beat,
          spb: clock.localSecondsPerBeat(beat),
        })),
        durationSeconds: clock.durationSeconds,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// clip-time.json — clipSourceTimeAt/FrameAt across play modes
// ---------------------------------------------------------------------------

interface ClipCaseSpec {
  name: string;
  loop: ClipLoopConfig;
  ctx: { startBeat: number; lengthBeat: number; videoDurSec: number; seed?: number };
  clock: ClockSpec;
  fps: number;
  frameCount: number;
}

const FLAT_120: ClockSpec = { bpm: 120, totalBeats: 64, segments: [] };
const WARPED: ClockSpec = { bpm: 120, totalBeats: 64, segments: [seg(0, 32, 'sine', 0.4, 8, 0)] };

const CLIP_CASES: ClipCaseSpec[] = [
  {
    name: 'one-shot-basic',
    loop: { mode: 'one-shot', startSec: 0, speed: 1, direction: 'forward' },
    ctx: { startBeat: 4, lengthBeat: 16, videoDurSec: 5 },
    clock: FLAT_120, fps: 30, frameCount: 150,
  },
  {
    name: 'one-shot-speed-2.5',
    loop: { mode: 'one-shot', startSec: 1, speed: 2.5, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 24, videoDurSec: 10 },
    clock: FLAT_120, fps: 30, frameCount: 300,
  },
  {
    name: 'one-shot-reverse',
    loop: { mode: 'one-shot', startSec: 4, speed: 1, direction: 'reverse' },
    ctx: { startBeat: 2, lengthBeat: 16, videoDurSec: 5 },
    clock: FLAT_120, fps: 30, frameCount: 150,
  },
  {
    name: 'one-shot-negative-start',
    loop: { mode: 'one-shot', startSec: -1.5, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 16, videoDurSec: 4 },
    clock: FLAT_120, fps: 24, frameCount: 96,
  },
  {
    name: 'time-loop-slice',
    loop: { mode: 'time', startSec: 1, endSec: 3, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'time-pingpong',
    loop: { mode: 'time', startSec: 1, endSec: 3, speed: 1, direction: 'forward', pingpong: true },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'time-reverse-slow',
    loop: { mode: 'time', startSec: 0.5, endSec: 4.5, speed: 0.5, direction: 'reverse' },
    ctx: { startBeat: 8, lengthBeat: 24, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'time-playstart-inside',
    loop: { mode: 'time', startSec: 1, endSec: 3, playStartSec: 2.2, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'time-preroll',
    loop: { mode: 'time', startSec: 2, endSec: 4, playStartSec: 0.5, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'time-preroll-off-file',
    loop: { mode: 'time', startSec: 1, endSec: 3, playStartSec: -0.8, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'beat-sync-4',
    loop: { mode: 'beat-sync', startSec: 0, endSec: 2, speed: 1, direction: 'forward', syncBeats: 4 },
    ctx: { startBeat: 4, lengthBeat: 24, videoDurSec: 4 },
    clock: FLAT_120, fps: 30, frameCount: 120,
  },
  {
    name: 'beat-sync-bpm',
    loop: {
      mode: 'beat-sync', startSec: 0.5, endSec: 3.5, speed: 1, direction: 'forward',
      syncUseBpm: true, syncBpm: 90,
    },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 5 },
    clock: FLAT_120, fps: 30, frameCount: 150,
  },
  {
    name: 'beat-sync-pingpong-reverse',
    loop: {
      mode: 'beat-sync', startSec: 0, endSec: 2, speed: 1, direction: 'reverse',
      pingpong: true, syncBeats: 3,
    },
    ctx: { startBeat: 1, lengthBeat: 24, videoDurSec: 4 },
    clock: FLAT_120, fps: 25, frameCount: 100,
  },
  {
    name: 'beat-sync-playstart',
    loop: {
      mode: 'beat-sync', startSec: 1, endSec: 3, playStartSec: 1.7, speed: 1,
      direction: 'forward', syncBeats: 4,
    },
    ctx: { startBeat: 0, lengthBeat: 24, videoDurSec: 6 },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'one-shot-warped',
    loop: { mode: 'one-shot', startSec: 0, speed: 1, direction: 'forward' },
    ctx: { startBeat: 2, lengthBeat: 24, videoDurSec: 20 },
    clock: WARPED, fps: 30, frameCount: 600,
  },
  {
    name: 'time-warped',
    loop: { mode: 'time', startSec: 1, endSec: 3, speed: 1, direction: 'forward' },
    ctx: { startBeat: 2, lengthBeat: 24, videoDurSec: 6 },
    clock: WARPED, fps: 30, frameCount: 180,
  },
  {
    name: 'beat-sync-warped',
    loop: { mode: 'beat-sync', startSec: 0, endSec: 2, speed: 1, direction: 'forward', syncBeats: 4 },
    ctx: { startBeat: 2, lengthBeat: 24, videoDurSec: 4 },
    clock: WARPED, fps: 30, frameCount: 120,
  },
  {
    name: 'random-default',
    loop: { mode: 'random', startSec: 0.5, endSec: 4.5, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6, seed: clipNoiseSeed('clip-a') },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'random-fast-dwell',
    loop: { mode: 'random', startSec: 0, endSec: 6, speed: 1, direction: 'forward', dwell: 0.25 },
    ctx: { startBeat: 0, lengthBeat: 32, videoDurSec: 6, seed: clipNoiseSeed('clip-b') },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'random-dwell-sec',
    loop: {
      mode: 'random', startSec: 0, endSec: 6, speed: 1, direction: 'forward',
      dwell: 2, dwellUnit: 'sec',
    },
    ctx: { startBeat: 4, lengthBeat: 32, videoDurSec: 6, seed: clipNoiseSeed('clip-c') },
    clock: FLAT_120, fps: 30, frameCount: 180,
  },
  {
    name: 'still-image',
    loop: { mode: 'time', startSec: 0, speed: 1, direction: 'forward' },
    ctx: { startBeat: 0, lengthBeat: 16, videoDurSec: 1 / 30 },
    clock: FLAT_120, fps: 30, frameCount: 1,
  },
];

/** Emit an expected frame only when safely inside it (see file header). */
function safeFrame(
  loop: ClipLoopConfig, ctx: ClipTimeCtx, beat: number, fps: number, frameCount: number,
): { frame: number | null } | {} {
  const frame = clipSourceFrameAt(loop, ctx, beat, fps, frameCount);
  if (frame === null) return { frame: null };
  if (frameCount <= 1) return { frame };
  const vt = clipSourceTimeAt(loop, ctx, beat);
  if (vt === null) return { frame: null };
  const frac = (vt * fps) % 1;
  if (frac < 1e-6 && vt * fps !== Math.round(vt * fps)) return {}; // boundary-adjacent
  if (frac > 1 - 1e-6) return {};
  return { frame };
}

function buildClipTimeFixture() {
  return {
    cases: CLIP_CASES.map((spec) => {
      const clock = makeClock(spec.clock);
      const ctx: ClipTimeCtx = {
        startBeat: spec.ctx.startBeat,
        lengthBeat: spec.ctx.lengthBeat,
        videoDurSec: spec.ctx.videoDurSec,
        seed: spec.ctx.seed,
        secondsAt: (b) => clock.secondsAt(b),
      };
      const beats = sampleBeats(spec.ctx.startBeat - 1.3, spec.ctx.startBeat + spec.ctx.lengthBeat + 2.1, 25);
      return {
        name: spec.name,
        loop: spec.loop,
        ctx: spec.ctx,
        clock: spec.clock,
        fps: spec.fps,
        frameCount: spec.frameCount,
        samples: beats.map((beat) => ({
          beat,
          timeSec: clipSourceTimeAt(spec.loop, ctx, beat),
          ...safeFrame(spec.loop, ctx, beat, spec.fps, spec.frameCount),
        })),
      };
    }),
    noiseSeeds: ['clip-a', 'clip-b', 'clip-c', 'c1', 'a-very-long-clip-identifier-000'].map(
      (id) => ({ id, seed: clipNoiseSeed(id) }),
    ),
  };
}

// ---------------------------------------------------------------------------
// transport.json — TransportController advance/loop-wrap/re-anchor
// ---------------------------------------------------------------------------

interface TransportCaseSpec {
  name: string;
  clock: ClockSpec;
  state: { playing: boolean; positionBeat: number; loopEnabled: boolean; loopStartBeat: number; loopEndBeat: number };
  steps: Array<{ dt: number; playing?: boolean; scrubBeat?: number }>;
}

const TRANSPORT_CASES: TransportCaseSpec[] = [
  {
    name: 'flat-advance',
    clock: FLAT_120,
    state: { playing: true, positionBeat: 0, loopEnabled: false, loopStartBeat: 0, loopEndBeat: 32 },
    steps: [{ dt: 0.5 }, { dt: 1.0 }, { dt: 0.016 }, { dt: 0 }],
  },
  {
    name: 'paused-then-resume',
    clock: FLAT_120,
    state: { playing: false, positionBeat: 5, loopEnabled: false, loopStartBeat: 0, loopEndBeat: 32 },
    steps: [{ dt: 1.0 }, { dt: 0.5, playing: true }, { dt: 0.25, playing: false }, { dt: 0.5, playing: true }],
  },
  {
    name: 'scrub-reanchor',
    clock: FLAT_120,
    state: { playing: true, positionBeat: 0, loopEnabled: false, loopStartBeat: 0, loopEndBeat: 32 },
    steps: [{ dt: 0.5 }, { dt: 0.5, scrubBeat: 10 }, { dt: 0.5 }],
  },
  {
    name: 'loop-wrap-inside',
    clock: FLAT_120,
    state: { playing: true, positionBeat: 7.5, loopEnabled: true, loopStartBeat: 4, loopEndBeat: 8 },
    steps: [{ dt: 0.5 }, { dt: 0.5 }, { dt: 2.5 }],
  },
  {
    name: 'loop-no-yank-outside',
    clock: FLAT_120,
    state: { playing: true, positionBeat: 9, loopEnabled: true, loopStartBeat: 4, loopEndBeat: 8 },
    steps: [{ dt: 0.5 }, { dt: 0.5 }],
  },
  {
    name: 'warped-local-rate',
    clock: WARPED,
    state: { playing: true, positionBeat: 4, loopEnabled: false, loopStartBeat: 0, loopEndBeat: 32 },
    steps: [{ dt: 0.01 }, { dt: 0.01 }, { dt: 0.25 }, { dt: 0.25 }, { dt: 1.5 }],
  },
  {
    name: 'warped-loop-wrap',
    clock: WARPED,
    state: { playing: true, positionBeat: 6.5, loopEnabled: true, loopStartBeat: 2, loopEndBeat: 7 },
    steps: [{ dt: 0.3 }, { dt: 0.3 }, { dt: 0.3 }, { dt: 4.0 }],
  },
  {
    name: 'negative-dt-clamped',
    clock: FLAT_120,
    state: { playing: true, positionBeat: 2, loopEnabled: false, loopStartBeat: 0, loopEndBeat: 32 },
    steps: [{ dt: -0.5 }, { dt: 0.5 }],
  },
];

/** Build a Composition whose derivedWarpSegments equal `spec.segments`. */
function compositionForClock(spec: ClockSpec): Composition {
  const track: Track = {
    id: 't', name: 'T', kind: 'track', parentId: null,
    sketch: { devices: [] }, automation: [],
    clips: spec.segments.map((s, i) => ({
      id: `wc${i}`, name: `W${i}`, startBeat: s.startBeat, lengthBeat: s.endBeat - s.startBeat,
      kind: 'effect' as const, sketch: { devices: [] },
      loop: { mode: 'time' as const, startSec: 0, speed: 1, direction: 'forward' as const },
      automation: [], exports: [],
      warps: [{
        id: `w${i}`, sourceDeviceId: 'd', waveform: s.waveform,
        amplitude: s.amplitude, periodBeats: s.periodBeats, phase: s.phase,
      }],
    })),
  };
  // A silent filler clip pins compositionLengthBeats to the spec's totalBeats so
  // the TS controller's internally-built curve matches the fixture's table size.
  const filler: Track = {
    id: 'fill', name: 'F', kind: 'track', parentId: null,
    sketch: { devices: [] }, automation: [],
    clips: [{
      id: 'fill-c', name: 'F', startBeat: 0, lengthBeat: spec.totalBeats,
      kind: 'effect' as const, sketch: { devices: [] },
      loop: { mode: 'time' as const, startSec: 0, speed: 1, direction: 'forward' as const },
      automation: [], exports: [], warps: [],
    }],
  };
  return {
    meta: { resolution: { width: 16, height: 16 }, baseBPM: spec.bpm, timeSignature: [4, 4] },
    tracks: [track, filler],
    rails: [],
    playMode: { defaultMode: 'time' },
  };
}

function buildTransportFixture() {
  return {
    cases: TRANSPORT_CASES.map((spec) => {
      // Guard: the TS controller derives its curve extent from the composition;
      // it must match the fixture totalBeats the C++ side will use.
      const comp = compositionForClock(spec.clock);
      const tc = new TransportController();
      const s: TransportState & { setPosition(b: number): void } = {
        ...spec.state,
        composition: comp,
        setPosition(beat: number) { this.positionBeat = Math.max(0, beat); },
      };
      const expected = spec.steps.map((step) => {
        if (step.playing !== undefined) s.playing = step.playing;
        if (step.scrubBeat !== undefined) s.positionBeat = step.scrubBeat;
        tc.advance(s, step.dt);
        return { beat: s.positionBeat, seconds: tc.secondsAt(s) };
      });
      return { name: spec.name, clock: spec.clock, state: spec.state, steps: spec.steps, expect: expected };
    }),
  };
}

// ---------------------------------------------------------------------------
// gate.json — precise-gate truth tables
// ---------------------------------------------------------------------------

function buildGateFixture() {
  const shouldHold: Array<{ precise: boolean; force: boolean; activeVideoCount: number; ready: boolean; expect: boolean }> = [];
  for (const precise of [false, true]) {
    for (const force of [false, true]) {
      for (const activeVideoCount of [0, 2]) {
        for (const ready of [false, true]) {
          shouldHold.push({
            precise, force, activeVideoCount, ready,
            expect: shouldHoldPrecise({ precise, force, activeVideoCount, ready }),
          });
        }
      }
    }
  }

  const readyCases = [
    { active: [] as string[], hasPump: false, readyIds: [] as string[] },
    { active: [], hasPump: true, readyIds: [] },
    { active: ['a'], hasPump: false, readyIds: ['a'] },
    { active: ['a'], hasPump: true, readyIds: [] },
    { active: ['a'], hasPump: true, readyIds: ['a'] },
    { active: ['a', 'b'], hasPump: true, readyIds: ['a'] },
    { active: ['a', 'b'], hasPump: true, readyIds: ['a', 'b'] },
  ].map((c) => ({
    ...c,
    expect: videoInputsReady(
      c.active.map((clipId) => ({ clipId })), c.hasPump, (id) => c.readyIds.includes(id),
    ),
  }));

  type Item = { clipId: string; tag: string };
  const item = (clipId: string, tag: string): Item => ({ clipId, tag });
  const pumpCases = [
    { holding: false, target: [item('a', 't'), item('b', 't')], displayed: [item('b', 'd'), item('c', 'd')] },
    { holding: true, target: [item('a', 't'), item('b', 't')], displayed: [item('b', 'd'), item('c', 'd')] },
    { holding: true, target: [], displayed: [item('x', 'd')] },
    { holding: true, target: [item('x', 't')], displayed: [] },
    { holding: true, target: [item('a', 't')], displayed: [item('a', 'd'), item('a', 'd2')] },
  ].map((c) => ({ ...c, expect: pumpActiveSet(c.holding, c.target, c.displayed) }));

  return { shouldHold, videoInputsReady: readyCases, pumpActiveSet: pumpCases };
}

// ---------------------------------------------------------------------------
// build.json — composite tree eval + sketch build + automation entries
// (comp_eval.h + sketch_build.h ↔ store.compositeTreeAtBeat + composite-frame.ts
// + clip-sketch.ts). Full compositions in, per-beat {sketch, automation} out.
// ---------------------------------------------------------------------------

let deviceSeq = 0;
const mkDev = (moduleType: string, id?: string, state?: Record<string, unknown>): Device => ({
  id: id ?? `d${deviceSeq++}`,
  moduleType,
  name: moduleType,
  capabilities: [],
  ...(state !== undefined ? { state } : {}),
});

const mkClip = (id: string, startBeat: number, lengthBeat: number, devices: Device[],
  over: Partial<Clip> = {}): Clip => ({
  id, name: id, startBeat, lengthBeat, kind: 'effect',
  sketch: { devices },
  loop: { mode: 'time', startSec: 0, speed: 1, direction: 'forward' },
  automation: [], exports: [], warps: [],
  ...over,
});

const mkTrack = (id: string, over: Partial<Track> = {}): Track => ({
  id, name: id, kind: 'track', parentId: null,
  sketch: { devices: [] }, automation: [], clips: [],
  ...over,
});

const mkComp = (tracks: Track[], over: Partial<Composition['meta']> = {}): Composition => ({
  meta: { resolution: { width: 1920, height: 1080 }, baseBPM: 120, timeSignature: [4, 4], ...over },
  tracks: [...tracks, makeMainBus()],
  rails: [],
  playMode: { defaultMode: 'time' },
});

interface BuildCaseSpec {
  name: string;
  composition: Composition;
  beats: number[];
  clipAutoTiming?: 'loop' | 'clip';
  ignoreSolo?: boolean;
}

function buildCases(): BuildCaseSpec[] {
  const cases: BuildCaseSpec[] = [];

  // 1. Empty timeline → no sketch, no automation.
  cases.push({ name: 'empty-timeline', composition: mkComp([mkTrack('t1')]), beats: [0, 4] });

  // 2. Two source tracks, custom background, blend fallbacks, overlap+bypass rules.
  {
    const t1 = mkTrack('t1', {
      clips: [
        mkClip('c1', 0, 8, [mkDev('source.noise', 'n1', { scale: 0.7 })], { blendMode: 5 }),
        // Overlapping later-started clip that is BYPASSED — pickActiveClip picks it
        // (latest-started wins) and then drops the whole track. c1 returns at beat 6+.
        mkClip('c2', 2, 4, [mkDev('source.solid_color', 's2')], { bypassed: true }),
      ],
    });
    const t2 = mkTrack('t2', {
      level: 0.5, blendMode: 3,
      clips: [mkClip('c3', 4, 8, [mkDev('source.solid_color', 's3', { color: [1, 0, 0] })])],
    });
    cases.push({
      name: 'two-source-tracks',
      composition: mkComp([t1, t2], { background: { mode: 'custom', color: '#3366aa' } }),
      beats: [1, 3, 6.5, 10, 20],
    });
  }

  // 3. Effect-only adjustment clip + clip wires + mod passthrough + dup-id dedupe
  //    + a non-catalog device (dropped).
  {
    const t1 = mkTrack('t1', {
      clips: [mkClip('c1', 0, 16, [
        // Duplicate device id (data bug): the second entry collides → dropped.
        mkDev('source.noise', 'dup'),
        mkDev('color.invert', 'dup'),
      ])],
    });
    const t2 = mkTrack('t2', {
      level: 0.6,
      clips: [mkClip('c2', 0, 16, [
        mkDev('color.invert', 'inv'),
        mkDev('mod.source.lfo', 'lfo', { rate: 0.25 }),
        mkDev('color.saturate', 'sat'),
        mkDev('legacy.fake', 'zz'), // not in the catalog → filtered out
      ], {
        sketch: {
          devices: [
            mkDev('color.invert', 'inv'),
            mkDev('mod.source.lfo', 'lfo', { rate: 0.25 }),
            mkDev('color.saturate', 'sat'),
            mkDev('legacy.fake', 'zz'),
          ],
          wires: [
            { id: 'x1', src: { instanceKey: 'lfo', field: 'output' }, dest: { instanceKey: 'sat', field: 'prescale' }, combine: 'add', magnitude: 'signed' },
            { id: 'x2', src: { instanceKey: 'zz', field: 'output' }, dest: { instanceKey: 'sat', field: 'prescale' } }, // endpoint not pushed → dropped
          ],
        },
      })],
    });
    cases.push({ name: 'effect-only-and-wires', composition: mkComp([t1, t2]), beats: [1] });
  }

  // 4. Nested groups: transparent / underlying / custom inputs, group FX,
  //    partial-opacity pass-through, solo restriction (+ ignoreSolo variant).
  const groupsComp = (): Composition => {
    const a = mkTrack('A', { clips: [mkClip('ca', 0, 8, [mkDev('source.solid_color', 'sa')])] });
    const g1 = mkTrack('G1', {
      kind: 'group', level: 0.7, blendMode: 2,
      sketch: { devices: [mkDev('color.invert', 'g1fx')] },
      automation: [{ id: 'l1', targetDeviceId: 'g1fx', targetField: 'strength', label: 'x', points: [{ x: 0, y: 0.1 }, { x: 8, y: 0.9, bend: 0.5 }] }],
    });
    const b = mkTrack('B', { parentId: 'G1', clips: [mkClip('cb', 0, 8, [mkDev('source.noise', 'sb')])] });
    const c = mkTrack('C', { parentId: 'G1', level: 0.8, clips: [mkClip('cc', 0, 8, [mkDev('color.saturate', 'ec')])] });
    const g2 = mkTrack('G2', {
      kind: 'group', groupInput: { mode: 'underlying' },
      sketch: { devices: [mkDev('color.hsl', 'g2fx')] },
    });
    const d = mkTrack('D', { parentId: 'G2', clips: [mkClip('cd', 0, 8, [mkDev('source.noise', 'sd')])] });
    const g3 = mkTrack('G3', { kind: 'group', level: 0.4, groupInput: { mode: 'custom', color: '#ff8800' } });
    const e = mkTrack('E', { parentId: 'G3', clips: [mkClip('ce', 0, 8, [mkDev('source.solid_color', 'se')])] });
    const f = mkTrack('F', { bypassed: true, clips: [mkClip('cf', 0, 8, [mkDev('source.noise', 'sf')])] });
    // 'black' input + an 'underlying' pass-through at PARTIAL opacity (the
    // wet/dry crossfade between the below content and the processed result).
    const g4 = mkTrack('G4', { kind: 'group', groupInput: { mode: 'black' } });
    const h = mkTrack('H', { parentId: 'G4', clips: [mkClip('ch', 0, 8, [mkDev('source.noise', 'sh')])] });
    const g5 = mkTrack('G5', { kind: 'group', level: 0.5, groupInput: { mode: 'underlying' }, sketch: { devices: [mkDev('color.invert', 'g5fx')] } });
    const i = mkTrack('I', { parentId: 'G5', clips: [mkClip('ci', 0, 8, [mkDev('color.saturate', 'ei')])] });
    return mkComp([a, g1, b, c, g2, d, g3, e, f, g4, h, g5, i]);
  };
  cases.push({ name: 'groups-nested', composition: groupsComp(), beats: [1] });
  {
    const comp = groupsComp();
    comp.tracks.find((t) => t.id === 'B')!.soloed = true;
    cases.push({ name: 'groups-solo', composition: comp, beats: [1] });
    cases.push({ name: 'groups-solo-ignored', composition: comp, beats: [1], ignoreSolo: true });
  }

  // 5. Rails: signed + unsigned, base curves, writer scale, writer-less reader,
  //    reader of a rail with no rail track.
  {
    const r1 = mkTrack('R1', {
      kind: 'rail', railId: 'r1',
      baseCurve: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8, bend: 0.5 }],
    });
    const r2 = mkTrack('R2', { kind: 'rail', railId: 'r2', railSigned: true });
    const t1 = mkTrack('t1', {
      clips: [mkClip('w1', 0, 16, [mkDev('source.noise', 'gen'), mkDev('mod.source.lfo', 'lfo')], {
        exports: [
          { id: 'e1', railId: 'r1', sourceDeviceId: 'lfo', sourceField: 'output', combine: 'add', magnitude: 'auto', scale: 2 },
          { id: 'e2', railId: 'r2', sourceDeviceId: 'lfo', sourceField: 'output', combine: 'add', magnitude: 'auto' },
          { id: 'e3', railId: 'r1', sourceDeviceId: 'missing', sourceField: 'output', combine: 'add', magnitude: 'auto' }, // device not pushed → dropped
        ],
      })],
    });
    const t2 = mkTrack('t2', {
      clips: [mkClip('rd1', 0, 16, [mkDev('color.saturate', 'sat')], {
        reads: [
          { id: 'rr1', railId: 'r1', targetDeviceId: 'sat', targetField: 'prescale', combine: 'mix', magnitude: 'auto', scale: 0.5 },
          { id: 'rr2', railId: 'r2', targetDeviceId: 'sat', targetField: 'prescale', combine: 'add', magnitude: 'auto' },
        ],
      })],
    });
    const t3 = mkTrack('t3', {
      clips: [mkClip('rd2', 0, 16, [mkDev('color.invert', 'inv2')], {
        reads: [
          // Writer-less rail WITH a rail track (base drives it) — none writes r3.
          { id: 'rr3', railId: 'r3', targetDeviceId: 'inv2', targetField: 'strength', combine: 'replace', magnitude: 'auto' },
          // Rail with NO rail track at all → base 0, unsigned.
          { id: 'rr4', railId: 'r4', targetDeviceId: 'inv2', targetField: 'strength', combine: 'add', magnitude: 'auto' },
        ],
      })],
    });
    const r3 = mkTrack('R3', {
      kind: 'rail', railId: 'r3', railSigned: true,
      baseCurve: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
    });
    const comp = mkComp([r1, r2, t1, t2, t3, r3]);
    comp.rails = [
      { id: 'r1', name: 'R1', defaultValue: 0, range: { min: 0, max: 1 } },
      { id: 'r2', name: 'R2', defaultValue: 0, range: { min: -1, max: 1 } },
    ];
    cases.push({ name: 'rails', composition: comp, beats: [2, 6] });
  }

  // 6. Track FX bus + track wires + main-bus master FX + automation lanes at
  //    clip/track/bus level (clip-relative timing in 'clip' mode).
  {
    const t1 = mkTrack('t1', {
      sketch: {
        devices: [mkDev('mod.source.lfo', 'tlfo'), mkDev('color.saturate', 'tsat')],
        wires: [{ id: 'y1', src: { instanceKey: 'tlfo', field: 'output' }, dest: { instanceKey: 'tsat', field: 'prescale' }, combine: 'add' }],
      },
      automation: [{ id: 'tl1', targetDeviceId: 'tsat', targetField: 'prescale', label: 'x', points: [{ x: 0, y: 0 }, { x: 16, y: 1 }], combine: 'add', magnitude: 'signed' }],
      clips: [mkClip('c1', 2, 8, [mkDev('source.noise', 'gen')], {
        automation: [{ id: 'cl1', targetDeviceId: 'gen', targetField: 'scale', label: 'x', points: [{ x: 0, y: 0.2 }, { x: 1, y: 0.9, bend: -0.4 }] }],
      })],
    });
    const comp = mkComp([t1]);
    const bus = comp.tracks.find((t) => t.id === 'main-bus')!;
    bus.sketch = { devices: [mkDev('color.hsl', 'mfx')] };
    bus.automation = [{ id: 'bl1', targetDeviceId: 'mfx', targetField: 'hue_shift', label: 'x', points: [{ x: 0, y: 0 }, { x: 32, y: 1 }] }];
    cases.push({ name: 'buses-automation-clip-mode', composition: comp, beats: [1, 2, 5.5, 9.9], clipAutoTiming: 'clip' });

    const comp2 = JSON.parse(JSON.stringify(comp)) as Composition;
    comp2.tracks.find((t) => t.id === 'main-bus')!.bypassed = true;
    cases.push({ name: 'buses-bypassed-loop-mode', composition: comp2, beats: [5.5], clipAutoTiming: 'loop' });
  }

  // 6b. Transparent background + an effect-only FIRST layer (no accumulator to
  //     process — the adjustment chain starts from nothing).
  {
    const t1 = mkTrack('t1', {
      level: 0.9,
      clips: [mkClip('fx1', 0, 8, [mkDev('color.invert', 'i1')])],
    });
    const t2 = mkTrack('t2', {
      clips: [mkClip('src1', 0, 8, [mkDev('source.noise', 'n1')])],
    });
    cases.push({
      name: 'transparent-bg-effect-first',
      composition: mkComp([t1, t2], { background: { mode: 'transparent' } }),
      beats: [1],
    });
  }

  // 7. Warped start-seconds baked onto clip chain entries.
  {
    const t1 = mkTrack('t1', {
      clips: [mkClip('cw', 0, 8, [mkDev('source.noise', 'g1')], {
        warps: [{ id: 'w1', sourceDeviceId: 'g1', waveform: 'sine', amplitude: 0.3, periodBeats: 4, phase: 0 }],
      })],
    });
    const t2 = mkTrack('t2', {
      clips: [mkClip('cl', 6, 8, [mkDev('source.solid_color', 'g2')])],
    });
    cases.push({ name: 'warps-startsec', composition: mkComp([t1, t2]), beats: [1, 7] });
  }

  // 8. Video clip (host-injected texture): the instance-key contract.
  {
    const t1 = mkTrack('t1', {
      clips: [mkClip('vc', 0, 8, [mkDev('source.video.file', 'v1'), mkDev('color.invert', 'vi')], {
        kind: 'video',
        source: { label: 'clip.mp4', durationFrames: 300, sourceKey: 'sk1', url: 'blob:media/clip', fps: 30 },
      })],
    });
    cases.push({ name: 'video-clip', composition: mkComp([t1]), beats: [1] });
  }

  return cases;
}

function buildBuildFixture() {
  seedTestPlugins();
  const savedComposition = store.composition;
  const savedTiming = store.clipAutoTiming;
  try {
    const cases = buildCases().map((spec) => {
      store.composition = spec.composition;
      store.warpEpoch++; // invalidate composite-frame's cached warp clock
      store.clipAutoTiming = spec.clipAutoTiming ?? 'loop';
      const frames = spec.beats.map((beat) => {
        const r = buildCompositeRenderAtBeat(beat, spec.ignoreSolo ?? false);
        return {
          beat,
          sketch: r ? JSON.parse(JSON.stringify(r.sketch)) : null,
          automation: JSON.parse(JSON.stringify(automationEntriesAtBeat(beat, spec.ignoreSolo ?? false))),
        };
      });
      return {
        name: spec.name,
        clipAutoTiming: spec.clipAutoTiming ?? 'loop',
        ignoreSolo: spec.ignoreSolo ?? false,
        composition: JSON.parse(JSON.stringify(spec.composition)),
        frames,
      };
    });
    return {
      plugins: TEST_PLUGINS.map((p) => ({
        id: p.id, schema: p.schema, capabilities: p.capabilities ?? [],
      })),
      cases,
    };
  } finally {
    store.composition = savedComposition;
    store.clipAutoTiming = savedTiming;
    store.warpEpoch++;
  }
}

// ---------------------------------------------------------------------------

describe('comp goldens (lock-step fixtures for native/src/sketch/comp)', () => {
  it('warp.json — WarpCurve/WarpClock', () => checkFixture('warp.json', buildWarpFixture()));
  it('clip-time.json — clipSourceTimeAt/FrameAt', () => checkFixture('clip-time.json', buildClipTimeFixture()));
  it('transport.json — TransportController', () => checkFixture('transport.json', buildTransportFixture()));
  it('gate.json — precise gate', () => checkFixture('gate.json', buildGateFixture()));
  it('build.json — tree eval + sketch build + automation', () => checkFixture('build.json', buildBuildFixture()));
});
