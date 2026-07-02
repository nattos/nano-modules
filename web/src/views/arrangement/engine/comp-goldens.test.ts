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
import { type WarpSegment, type ClipLoopConfig } from '../model/composition';
import { WarpClock } from './warp-clock';
import { clipSourceTimeAt, clipSourceFrameAt, clipNoiseSeed, type ClipTimeCtx } from './clip-time';
import { videoInputsReady, shouldHoldPrecise, pumpActiveSet } from './precise-gate';

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
// transport.json — FROZEN fixture. Its TS reference (transport-clock.ts) was
// deleted when the C++ comp transport became the only implementation; the
// fixture is pinned by native test_comp_time alone and can no longer be
// regenerated (change the C++ deliberately + hand-update if ever needed).
// ---------------------------------------------------------------------------

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

describe('comp goldens (lock-step fixtures for native/src/sketch/comp)', () => {
  it('warp.json — WarpCurve/WarpClock', () => checkFixture('warp.json', buildWarpFixture()));
  it('clip-time.json — clipSourceTimeAt/FrameAt', () => checkFixture('clip-time.json', buildClipTimeFixture()));
  it('gate.json — precise gate', () => checkFixture('gate.json', buildGateFixture()));
});

// build.json — FROZEN fixture (like transport.json). Its TS reference (the
// clip-sketch.ts / composite-frame.ts builders) was deleted when the offline
// exporter moved onto the comp executor — the composite build is pinned by the
// native replay alone (test_comp_build.cpp deep-equals sketch_build.h against
// the frozen JSON). UPDATE_GOLDENS regenerates only the fixtures above.
