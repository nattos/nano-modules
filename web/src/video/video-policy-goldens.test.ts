/**
 * video-policy-goldens.test.ts — shared golden fixtures for the C++ video
 * policy twins (native/src/media/{access_classifier,cost_tracker,read_ahead,
 * frame_cache_policy}.h).
 *
 * TS is the REFERENCE. With UPDATE_GOLDENS=1 this suite regenerates
 * native/tests/fixtures/video/*.json from the TS code; without it, it verifies
 * the TS code still reproduces the committed fixtures (so TS drift is caught
 * too). The Catch2 twin (native/tests/test_video_policy.cpp) replays the SAME
 * fixtures against the C++ ports — that pair of suites IS the lock-step
 * contract, exactly as comp-goldens.test.ts ↔ test_comp_time.cpp is for comp.
 *
 * Why this matters beyond tidiness: the perf regression suite compares cache
 * hit rate, precache depth and stall counts across the two hosts. Those numbers
 * are only comparable if both hosts classify the access pattern the same way,
 * read ahead to the same frames, and evict in the same order.
 *
 * Numeric parity note: every scenario is scripted (no wall clock, no RNG at
 * replay time — the pull lists are IN the fixture). The only non-exact
 * operations are Math.exp (histogram time decay) and Math.sqrt (stdev), which
 * may differ from libm by ~1 ulp; the native replay compares numbers with a
 * tolerance and mode strings exactly. Scenarios are built so no decision sits
 * on a knife-edge threshold.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccessClassifier, type AccessMode, type ClassifierSnapshot } from './access-classifier';
import { CostTracker, classify } from './cost-tracker';
import { computeReadAheadTargets, computePinnedFrames, READAHEAD_DEPTH } from './read-ahead';
import { FrameCache, type GpuHostLike } from './frame-cache';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../native/tests/fixtures/video',
);
const UPDATE = !!process.env.UPDATE_GOLDENS;

function checkFixture(name: string, data: unknown) {
  const file = path.join(FIXTURES_DIR, name);
  if (UPDATE) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
    return;
  }
  expect(
    fs.existsSync(file),
    `${name} missing — run UPDATE_GOLDENS=1 npx vitest run video-policy-goldens`,
  ).toBe(true);
  expect(data).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// read-ahead.json — the pure target/pin policy
// ---------------------------------------------------------------------------

function buildReadAheadFixture() {
  const MODES: AccessMode[] = [
    'Sequential', 'Reverse', 'Strided', 'Loop', 'Hotspots', 'Scrub', 'Random',
  ];
  const targets: unknown[] = [];
  for (const mode of MODES) {
    for (const frameIdx of [0, 7, 97, 99]) {          // includes both clamp edges
      for (const motionDir of [1, -1]) {
        for (const stride of [undefined, 3, -4]) {
          const inp = {
            mode, frameIdx, frameCount: 100, motionDir,
            depth: READAHEAD_DEPTH, stride,
          };
          targets.push({ ...inp, expect: computeReadAheadTargets(inp) });
        }
      }
    }
  }
  // Depth 0 and a 1-frame source: the degenerate cases a pump hits on a still.
  for (const [depth, frameCount] of [[0, 100], [5, 1], [12, 8]]) {
    const inp = { mode: 'Sequential' as AccessMode, frameIdx: 0, frameCount, motionDir: 1, depth };
    targets.push({ ...inp, expect: computeReadAheadTargets(inp) });
  }

  const pinCases: Array<Partial<ClassifierSnapshot> & { mode: AccessMode }> = [
    { mode: 'Sequential', confidence: 1 },
    { mode: 'Loop', confidence: 1, loopRange: [10, 19] },
    { mode: 'Loop', confidence: 1, loopRange: [5, 5] },
    { mode: 'Loop', confidence: 1, loopRange: [9, 4] },      // inverted ⇒ empty
    { mode: 'Loop', confidence: 1 },                          // no range ⇒ empty
    { mode: 'Hotspots', confidence: 1, hotFrames: [4, 8, 1] },
    { mode: 'Hotspots', confidence: 1 },
    { mode: 'Random', confidence: 1 },
  ];
  const pinned = pinCases.map((c) => ({
    ...c, expect: computePinnedFrames(c as ClassifierSnapshot),
  }));

  return { depth: READAHEAD_DEPTH, targets, pinned };
}

// ---------------------------------------------------------------------------
// classifier.json — scripted pull streams, snapshot after every pull
// ---------------------------------------------------------------------------

/** A tiny deterministic LCG — only used to AUTHOR the pull lists; the lists
 *  themselves are written into the fixture, so the replay needs no RNG. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface PullScript { name: string; pulls: [number, number][] }

function buildPullScripts(): PullScript[] {
  const FRAME_MS = 1000 / 30;
  const at = (i: number) => Math.round(i * FRAME_MS * 100) / 100;   // stable decimals

  const scripts: PullScript[] = [];

  // Forward play.
  scripts.push({
    name: 'sequential',
    pulls: Array.from({ length: 64 }, (_, i) => [i, at(i)] as [number, number]),
  });

  // Forward play sampled by a 60 Hz render loop — every frame pulled twice.
  // The dedupe path must keep this classified as Sequential, not Strided.
  scripts.push({
    name: 'sequential-doubled',
    pulls: Array.from({ length: 128 }, (_, i) => [i >> 1, at(i / 2)] as [number, number]),
  });

  // Reverse play.
  scripts.push({
    name: 'reverse',
    pulls: Array.from({ length: 64 }, (_, i) => [200 - i, at(i)] as [number, number]),
  });

  // Thumbnail strip / fast-forward.
  scripts.push({
    name: 'strided',
    pulls: Array.from({ length: 48 }, (_, i) => [i * 7, at(i)] as [number, number]),
  });

  // A tight loop over [10, 29], five cycles.
  {
    const pulls: [number, number][] = [];
    let t = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let f = 10; f <= 29; f++) pulls.push([f, at(t++)]);
    }
    scripts.push({ name: 'loop', pulls });
  }

  // Ping-pong: the mode lags each turn, which is exactly why read-ahead
  // follows live motion direction rather than the classified mode.
  {
    const pulls: [number, number][] = [];
    let t = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let f = 0; f <= 15; f++) pulls.push([f, at(t++)]);
      for (let f = 14; f >= 1; f--) pulls.push([f, at(t++)]);
    }
    scripts.push({ name: 'pingpong', pulls });
  }

  // Three frames cycled in a fixed order. This reads as **Loop**, not
  // Hotspots — the wrap is a clean, tightly-clustered reset every third pull,
  // which is exactly the Loop signature. Kept as a golden because it pins that
  // (slightly counterintuitive) priority between the two modes.
  {
    const pulls: [number, number][] = [];
    const hot = [3, 41, 77];
    let t = 0;
    for (let i = 0; i < 60; i++) pulls.push([hot[i % 3], at(t++)]);
    scripts.push({ name: 'three-frame-cycle', pulls });
  }

  // A real hotspot pattern: the same few frames dominate, but they're reached
  // from irregular positions, so nothing looks periodic. Frequency mass — not
  // stride structure — is the only signal here.
  {
    const rnd = lcg(0x5EED);
    const hot = [10, 200, 350];
    const pulls: [number, number][] = [];
    let t = 0;
    for (let i = 0; i < 24; i++) {
      for (const f of hot) pulls.push([f, at(t++)]);
      pulls.push([Math.floor(rnd() * 500), at(t++)]);
    }
    scripts.push({ name: 'hotspots', pulls });
  }

  // Interactive scrubbing: short forward drags separated by big jumps.
  {
    const rnd = lcg(0xC0FFEE);
    const pulls: [number, number][] = [];
    let f = 100;
    let t = 0;
    for (let i = 0; i < 12; i++) {
      const burst = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < burst; k++) pulls.push([f++, at(t++)]);
      f += Math.floor(rnd() * 60) - 30;
      if (f < 0) f = 0;
    }
    scripts.push({ name: 'scrub', pulls });
  }

  // No structure at all.
  {
    const rnd = lcg(0xBADF00D);
    const pulls: [number, number][] = [];
    for (let i = 0; i < 80; i++) pulls.push([Math.floor(rnd() * 300), at(i)]);
    scripts.push({ name: 'random', pulls });
  }

  // A pattern that CHANGES: sequential play, then a hard cut to scrubbing.
  // Exercises the shock path and the two-run hysteresis commit.
  {
    const pulls: [number, number][] = [];
    let t = 0;
    for (let f = 0; f < 40; f++) pulls.push([f, at(t++)]);
    let f = 500;
    for (let i = 0; i < 10; i++) {
      for (let k = 0; k < 3; k++) pulls.push([f++, at(t++)]);
      f += (i % 2 === 0 ? 40 : -55);
    }
    scripts.push({ name: 'mode-switch', pulls });
  }

  return scripts;
}

/** The snapshot, flattened so the C++ replay reads the same shape. */
function flatSnapshot(s: ClassifierSnapshot) {
  return {
    mode: s.mode,
    confidence: s.confidence,
    stride: s.stride ?? null,
    loopRange: s.loopRange ?? null,
    hotFrames: s.hotFrames ?? null,
  };
}

function buildClassifierFixture() {
  return buildPullScripts().map((script) => {
    const c = new AccessClassifier();
    const snapshots = script.pulls.map(([frameIdx, t]) => {
      c.recordPull(frameIdx, t);
      return flatSnapshot(c.snapshot());
    });
    // The read-ahead set the FINAL mode produces — the policy pair end to end.
    const finalSnap = c.snapshot();
    const lastIdx = script.pulls[script.pulls.length - 1][0];
    const prevIdx = script.pulls[script.pulls.length - 2]?.[0] ?? lastIdx;
    const motionDir = lastIdx - prevIdx < 0 ? -1 : 1;
    return {
      name: script.name,
      pulls: script.pulls,
      snapshots,
      readAhead: computeReadAheadTargets({
        mode: finalSnap.mode, frameIdx: lastIdx, frameCount: 1000,
        motionDir, depth: READAHEAD_DEPTH, stride: finalSnap.stride,
      }),
      pinned: computePinnedFrames(finalSnap),
    };
  });
}

// ---------------------------------------------------------------------------
// cost.json — EWMA buckets + the class thresholds
// ---------------------------------------------------------------------------

interface CostPull {
  stride: number; decodeMs: number; firstByteMs?: number; payloadBytes?: number;
}

function flatCost(t: CostTracker) {
  const s = t.snapshot();
  return { ...s };
}

function buildCostFixture() {
  const scenarios: Array<{ name: string; pulls: CostPull[] }> = [];

  // A cheap random-access codec (DXV): contiguous and seek decodes both fast.
  scenarios.push({
    name: 'fast-random',
    pulls: Array.from({ length: 40 }, (_, i) => ({
      stride: i % 8 === 0 ? 12 : 1,
      decodeMs: i % 8 === 0 ? 3.5 : 2.0,
      firstByteMs: 0.4,
      payloadBytes: 90_000 + (i % 5) * 1000,
    })),
  });

  // Expensive seeks (h264 keyframe walk): contiguous cheap, seeks brutal.
  scenarios.push({
    name: 'slow-seek',
    pulls: Array.from({ length: 40 }, (_, i) => ({
      stride: i % 6 === 0 ? -30 : 1,
      decodeMs: i % 6 === 0 ? 120 : 4,
      firstByteMs: 12,
    })),
  });

  // Everything slow.
  scenarios.push({
    name: 'slow-decode',
    pulls: Array.from({ length: 40 }, () => ({ stride: 1, decodeMs: 80 })),
  });

  // Below the sample floor ⇒ Unknown throughout.
  scenarios.push({
    name: 'undersampled',
    pulls: Array.from({ length: 10 }, () => ({ stride: 1, decodeMs: 1 })),
  });

  // The undersampled-contiguous fallback: read-ahead keeps every sequential
  // pull warm, so ONLY seeks ever reach the tracker (meanDecode stays 0).
  scenarios.push({
    name: 'seek-bucket-only',
    pulls: Array.from({ length: 40 }, () => ({ stride: 0, decodeMs: 6 })),
  });

  const built = scenarios.map(({ name, pulls }) => {
    const t = new CostTracker();
    const snapshots = pulls.map((p) => { t.recordPull(p); return flatCost(t); });
    return { name, pulls, snapshots };
  });

  // Seeding from a persisted profile caps the sample count so live pulls can
  // still move the EWMAs.
  const seed = {
    meanFrameDecodeMs: 8, seekDecodeMs: 60, seekPenaltyMs: 52,
    firstByteLatencyMs: 3, payloadBytesPerFrame: 120_000,
    samples: 500, costClass: 'SlowSeek' as const,
  };
  const seedPulls: CostPull[] = [{ stride: 1, decodeMs: 2 }, { stride: 9, decodeMs: 9 }];
  const seeded = new CostTracker();
  seeded.seedFromPersisted(seed);
  const seedSnapshots = [flatCost(seeded)];
  for (const p of seedPulls) {
    seeded.recordPull(p);
    seedSnapshots.push(flatCost(seeded));
  }

  // Direct threshold probes around every branch of classify().
  const classifyCases = [
    [0, 0, 0], [31, 1, 1], [32, 0, 0], [32, 0, 5], [32, 0, 10], [32, 0, 60],
    [32, 51, 1], [32, 50, 1], [32, 5, 5], [32, 5, 14], [32, 5, 16],
    [32, 9.9, 9], [32, 10, 10], [1000, 1, 1],
  ].map(([samples, meanDecode, seekDecode]) => ({
    samples, meanDecode, seekDecode, expect: classify(samples, meanDecode, seekDecode),
  }));

  return {
    scenarios: built,
    seeded: { seed, pulls: seedPulls, snapshots: seedSnapshots },
    classify: classifyCases,
  };
}

// ---------------------------------------------------------------------------
// cache.json — residency, eviction order, and hit/miss accounting
// ---------------------------------------------------------------------------

type CacheOp =
  | { op: 'reserve'; frame: number; width: number; height: number; format: number }
  | { op: 'markReady'; frame: number }
  | { op: 'lookup'; frame: number }
  | { op: 'setPinned'; frames: number[] }
  | { op: 'advance'; ms: number }
  | { op: 'stats' }
  | { op: 'resetStats' }
  | { op: 'clear' };

/** Hands out sequential handles and logs every release, so the fixture pins
 *  WHICH texture was freed and in what order — the eviction contract. */
class FakePool implements GpuHostLike {
  next = 1;
  released: number[] = [];
  createTexture(): number { return this.next++; }
  release(handle: number): void { this.released.push(handle); }
}

function runCacheScript(budgetBytes: number, ops: CacheOp[]) {
  const pool = new FakePool();
  let clock = 0;
  const cache = new FrameCache(pool, budgetBytes, { now: () => clock, recentWindowMs: 1000 });
  const trace: unknown[] = [];
  for (const o of ops) {
    switch (o.op) {
      case 'reserve':
        trace.push({ op: o.op, frame: o.frame, handle: cache.reserve(o.frame, o.width, o.height, o.format) });
        break;
      case 'markReady':
        cache.markReady(o.frame);
        trace.push({ op: o.op, frame: o.frame });
        break;
      case 'lookup':
        trace.push({ op: o.op, frame: o.frame, handle: cache.lookup(o.frame) });
        break;
      case 'setPinned':
        cache.setPinned(o.frames);
        trace.push({ op: o.op, pinned: cache.pinnedFrameIndices() });
        break;
      case 'advance':
        clock += o.ms;
        trace.push({ op: o.op, clock });
        break;
      case 'stats':
        trace.push({ op: o.op, stats: cache.stats(), cached: cache.cachedFrameIndices() });
        break;
      case 'resetStats':
        cache.resetStats();
        trace.push({ op: o.op });
        break;
      case 'clear':
        cache.clear();
        trace.push({ op: o.op });
        break;
    }
  }
  return {
    trace,
    released: pool.released,
    cached: cache.cachedFrameIndices(),
    bytes: cache.currentBytes,
    stats: cache.stats(),
  };
}

/** reserve + markReady + lookup, the ordinary "decode and present" cycle. */
function fill(frame: number, w = 64, h = 64, format = 1): CacheOp[] {
  return [
    { op: 'reserve', frame, width: w, height: h, format },
    { op: 'markReady', frame },
    { op: 'lookup', frame },
  ];
}

function buildCacheFixture() {
  const FRAME_BYTES = 64 * 64 * 4;   // 16 KiB at format 1 (RGBA8)

  const scenarios: Array<{ name: string; budgetBytes: number; ops: CacheOp[] }> = [];

  // Plain LRU: budget for 4 frames, walk 8 — the oldest four go.
  scenarios.push({
    name: 'lru-eviction',
    budgetBytes: FRAME_BYTES * 4,
    ops: [
      ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((f) => fill(f)),
      { op: 'stats' },
    ],
  });

  // A reserved-but-not-ready entry is a MISS (still black) and must not be
  // evicted (its decode is writing into it).
  scenarios.push({
    name: 'not-ready-is-a-miss',
    budgetBytes: FRAME_BYTES * 2,
    ops: [
      { op: 'reserve', frame: 0, width: 64, height: 64, format: 1 },
      { op: 'lookup', frame: 0 },
      ...fill(1),
      ...fill(2),                       // forces eviction with 0 still pending
      { op: 'markReady', frame: 0 },
      { op: 'lookup', frame: 0 },
      { op: 'stats' },
    ],
  });

  // Pinned frames survive while LRU is drained; pinned-oldest only goes when
  // pinned alone blows the budget (and that sets the sticky flag).
  scenarios.push({
    name: 'pinned-survives-then-forced',
    budgetBytes: FRAME_BYTES * 3,
    ops: [
      ...fill(10), ...fill(11), ...fill(12),
      { op: 'setPinned', frames: [10, 11, 12] },
      ...fill(20),                      // no LRU to take — forces a pinned evict
      { op: 'stats' },
      ...fill(21),
      { op: 'stats' },
    ],
  });

  // Un-pinning drops a frame back to LRU without evicting it.
  scenarios.push({
    name: 'unpin-drops-to-lru',
    budgetBytes: FRAME_BYTES * 2,
    ops: [
      ...fill(1), ...fill(2),
      { op: 'setPinned', frames: [1] },
      { op: 'setPinned', frames: [] },
      ...fill(3),
      { op: 'stats' },
    ],
  });

  // The rolling window: events older than recentWindowMs stop counting, while
  // the cumulative counters keep climbing.
  scenarios.push({
    name: 'rolling-window',
    budgetBytes: FRAME_BYTES * 8,
    ops: [
      ...fill(1), ...fill(2),
      { op: 'lookup', frame: 99 },      // miss
      { op: 'stats' },
      { op: 'advance', ms: 1500 },
      { op: 'stats' },
      { op: 'lookup', frame: 1 },
      { op: 'stats' },
      { op: 'resetStats' },
      { op: 'stats' },
    ],
  });

  // Format sizing: an RGBA32F frame costs 4× an RGBA8 one, so it evicts 4×.
  scenarios.push({
    name: 'format-sizing',
    budgetBytes: FRAME_BYTES * 4,
    ops: [
      ...[0, 1, 2, 3].flatMap((f) => fill(f)),
      ...fill(9, 64, 64, 5),            // RGBA32F: 64 KiB
      { op: 'stats' },
      { op: 'clear' },
      { op: 'stats' },
    ],
  });

  return scenarios.map((s) => ({ ...s, result: runCacheScript(s.budgetBytes, s.ops) }));
}

// ---------------------------------------------------------------------------

describe('video policy goldens (lock-step fixtures for native/src/media)', () => {
  it('read-ahead.json — target + pin policy', () =>
    checkFixture('read-ahead.json', buildReadAheadFixture()));
  it('classifier.json — access classification', () =>
    checkFixture('classifier.json', buildClassifierFixture()));
  it('cost.json — cost EWMAs + classification', () =>
    checkFixture('cost.json', buildCostFixture()));
  it('cache.json — residency + eviction', () =>
    checkFixture('cache.json', buildCacheFixture()));
});
