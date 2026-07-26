/**
 * PERFORMANCE REGRESSION suite — decode-pump behaviour under a realistic
 * arrangement, gated against COMMITTED PER-BACKEND baselines.
 *
 * Manually triggered; it is realtime work and it is not part of the default e2e
 * run (jest.config.js excludes test/perf).
 *
 *   cmake --build native/build --target comp_test_runner
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest --config jest.perf.config.js
 *   # after an INTENDED change:
 *   UPDATE_BASELINES=1 GPU_TEST_BASE_URL=http://localhost:5173 npx jest --config jest.perf.config.js
 *
 * What is gated, and why the bands differ:
 *
 *   RATIO metrics (cache hit rate, precache adherence, stall fraction, seek
 *   counts) are machine-INDEPENDENT — they fall out of the shared policy twins
 *   (native/src/media/*.h ↔ web/src/video/*.ts), not out of how fast the box is.
 *   Tight bands, hard fail. These are the numbers that catch "someone shrank
 *   the read-ahead depth" or "the cache stopped pinning the loop".
 *
 *   WALL-CLOCK metrics (mean decode ms) are not. A slower machine must not be
 *   able to manufacture a red run, so they get a generous band that still trips
 *   on a large move. They are recorded mostly so a regression has context.
 *
 * Baselines live in native/tests/fixtures/perf/<backend>.json — per backend
 * because the two hosts have genuinely different decode plumbing (WebGPU BC1 +
 * an async prefetch scheduler vs Metal BC1 + a synchronous one). Comparing the
 * hosts to EACH OTHER is the parity suites' job; this suite compares each host
 * to its own past.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  forEachBackend, runCompScenario, ensureCompRunnerPage, currentBackend, type CompScenario,
} from '../comp-test-helpers';
import { mkComposition, mkTrack, videoClip, type Json } from '../fixtures/comp-docs';

const BASELINE_DIR = path.resolve(__dirname, '..', '..', '..', 'native', 'tests', 'fixtures', 'perf');
const UPDATE = !!process.env.UPDATE_BASELINES;

/** A recorded run: metric name → value. */
type Metrics = Record<string, number | string>;

/** Per-metric tolerance. `ratio` bands are absolute (these are 0..1 numbers);
 *  `ms` bands are relative, with a floor so tiny values don't trip on noise. */
interface Band { kind: 'ratio' | 'count' | 'ms' | 'exact'; tol?: number }

const BANDS: Record<string, Band> = {
  hitRate: { kind: 'ratio', tol: 0.05 },
  precacheAdherence: { kind: 'ratio', tol: 0.05 },
  stallFraction: { kind: 'ratio', tol: 0.02 },
  injects: { kind: 'count', tol: 0.1 },
  cachedFrames: { kind: 'count', tol: 0.25 },
  decodes: { kind: 'count', tol: 0.15 },
  meanDecodeMs: { kind: 'ms', tol: 2.0 },
  seekDecodeMs: { kind: 'ms', tol: 2.0 },
  accessMode: { kind: 'exact' },
  costClass: { kind: 'exact' },
};

function baselinePath(backend: string): string {
  return path.join(BASELINE_DIR, `${backend}.json`);
}

function loadBaselines(backend: string): Record<string, Metrics> {
  const file = baselinePath(backend);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Metrics>;
}

const recorded: Record<string, Record<string, Metrics>> = {};

function record(backend: string, name: string, metrics: Metrics): void {
  (recorded[backend] ??= {})[name] = metrics;
}

/**
 * Compare against the committed baseline. Missing baseline ⇒ instructive
 * failure, not a silent pass: a perf gate that quietly accepts anything is
 * worse than no gate.
 */
function gate(backend: string, name: string, metrics: Metrics): void {
  record(backend, name, metrics);
  if (UPDATE) return;
  const base = loadBaselines(backend)[name];
  if (!base) {
    throw new Error(
      `no baseline for '${name}' on ${backend} — run with UPDATE_BASELINES=1 ` +
      `to record it into ${baselinePath(backend)}`);
  }
  const failures: string[] = [];
  for (const [key, want] of Object.entries(base)) {
    const got = metrics[key];
    const band = BANDS[key] ?? { kind: 'count', tol: 0.2 };
    if (band.kind === 'exact' || typeof want === 'string' || typeof got === 'string') {
      if (got !== want) failures.push(`${key}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      continue;
    }
    if (got === undefined) { failures.push(`${key}: missing`); continue; }
    const tol = band.tol ?? 0.2;
    const limit = band.kind === 'ratio'
      ? tol
      // Relative band with an absolute floor: a 0.2 ms baseline shouldn't fail
      // on 0.05 ms of scheduler noise.
      : Math.max(band.kind === 'ms' ? 1.0 : 1, Math.abs(want) * tol);
    if (Math.abs(got - want) > limit) {
      failures.push(`${key}: ${got.toFixed(3)} vs baseline ${want.toFixed(3)} (±${limit.toFixed(3)})`);
    }
  }
  if (failures.length) {
    throw new Error(
      `[${backend}] ${name} regressed:\n  ` + failures.join('\n  ') +
      `\n(intended? re-record with UPDATE_BASELINES=1)`);
  }
}

/** Round so an insignificant last-digit wobble doesn't churn the fixture. */
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The layout, ported from video-stall-benchmark.test.ts: three tracks staggered
 * so two clips are live at most playhead positions, each play mode exercised.
 *
 * DXV only, and no `random` mode. Native is DXV-first (h264 is the AVFoundation
 * follow-up), and `random` is a genuinely stochastic driver on web — neither
 * belongs in a suite whose whole point is comparable numbers.
 */
function benchDoc(): Json {
  const media = 'test_dxv.mov';
  return mkComposition([
    mkTrack('t-a', [
      videoClip('a1', 0, 8, media),
      videoClip('a2', 8, 8, media, {
        loop: { mode: 'beat-sync', startSec: 0, speed: 1, direction: 'forward', syncBeats: 4 },
      }),
      videoClip('a3', 16, 8, media),
    ]),
    mkTrack('t-b', [
      videoClip('b1', 4, 8, media, {
        loop: { mode: 'one-shot', startSec: 0, speed: 1, direction: 'forward' },
      }),
      videoClip('b2', 12, 8, media),
    ]),
    mkTrack('t-c', [
      videoClip('c1', 0, 10, media, {
        loop: { mode: 'time', startSec: 0, speed: 0.5, direction: 'forward' },
      }),
      videoClip('c2', 10, 10, media),
    ]),
  ]);
}

/** Flatten a run's telemetry into the gated metric set. */
function metricsFrom(run: Awaited<ReturnType<typeof runCompScenario>>, clipId: string): Metrics {
  const t = run.videoClips[clipId] as Record<string, number | string> | undefined;
  if (!t) throw new Error(`no telemetry for clip '${clipId}'`);
  const hits = (t.cacheHits as number) ?? 0;
  const misses = (t.cacheMisses as number) ?? 0;
  const decodes = (t.decodes as number) ?? misses;
  return {
    hitRate: r3(hits + misses > 0 ? hits / (hits + misses) : 0),
    injects: (t.injects as number) ?? 0,
    cachedFrames: (t.cachedFrames as number) ?? 0,
    decodes,
    meanDecodeMs: r3((t.meanDecodeMs as number) ?? 0),
    seekDecodeMs: r3((t.seekDecodeMs as number) ?? 0),
    accessMode: (t.accessMode as string) ?? '?',
    costClass: (t.costClass as string) ?? '?',
  };
}

/** Play the whole arrangement once, fixed-step. */
function benchScenario(over: Partial<CompScenario> = {}): CompScenario {
  return {
    doc: benchDoc(),
    width: 128,
    height: 128,
    ops: [
      { seek: 0 },
      // ~4 s at 120 BPM ⇒ 8 beats, crossing the first two clip boundaries.
      { play: { frames: 240, dtSec: 1 / 60 } },
      { capture: 'end' },
    ],
    ...over,
  };
}

forEachBackend((backend) => {
  describe(`comp decode perf (${backend})`, () => {
    jest.setTimeout(600_000);

    beforeAll(async () => {
      if (backend === 'puppeteer') await ensureCompRunnerPage();
    });

    afterAll(() => {
      if (!UPDATE) return;
      const b = currentBackend();
      const merged = { ...loadBaselines(b), ...(recorded[b] ?? {}) };
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      fs.writeFileSync(baselinePath(b), JSON.stringify(merged, null, 1) + '\n');
    });

    it('sequential playback keeps the cache warm', async () => {
      const run = await runCompScenario(benchScenario());
      run.expectNothingSkipped();
      // The clip that is live from beat 0 and plays straight through.
      gate(backend, 'sequential/a1', metricsFrom(run, 'a1'));
      gate(backend, 'sequential/c1', metricsFrom(run, 'c1'));
    });

    it('the whole arrangement stalls no more than the baseline', async () => {
      const run = await runCompScenario(benchScenario({ precise: true }));
      run.expectNothingSkipped();
      expect(run.frames).toBeGreaterThan(0);
      gate(backend, 'precise/transport', {
        stallFraction: r3(run.stalledFrames / Math.max(1, run.frames)),
      });
    });

    it('read-ahead actually reaches the frames the playhead wants', async () => {
      const run = await runCompScenario(benchScenario());
      run.expectNothingSkipped();
      // Adherence = the share of pulls a resident frame satisfied. With
      // read-ahead disabled this collapses toward the "every new source frame
      // is a miss" floor, which is exactly the regression this gate catches.
      const t = run.videoClips['a1'] as Record<string, number>;
      const hits = t.cacheHits ?? 0;
      const misses = t.cacheMisses ?? 0;
      gate(backend, 'readahead/a1', {
        precacheAdherence: r3(hits + misses > 0 ? hits / (hits + misses) : 0),
      });
    });
  });
});
