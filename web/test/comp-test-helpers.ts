/**
 * Dual-backend COMPOSITION test framework.
 *
 * The comp-mode sibling of `gpu-test-helpers.ts`: one `CompScenario` runs
 * against either backend from a single test body, dispatching on the ambient
 * backend `forEachBackend` sets.
 *
 *   - `puppeteer` → `comp-test-runner.html` (`window.__compRun`), which drives
 *     `ArrEngine` paused + seek-stepped through `executor.wasm`;
 *   - `metal` → the `comp_test_runner` CLI, which drives `comp::CompExecutor`
 *     natively against the Metal GPUBackend.
 *
 * Both walk the SAME ops and return the same `CompRunResult`, so a capture's
 * pixels are directly comparable — the web side reads back raw RGBA8 off the
 * GPU rather than going through TraceCapture (which checkerboards and forces
 * alpha opaque).
 *
 * Usage:
 *   forEachBackend((backend) => {
 *     describe(`comp (${backend})`, () => {
 *       it('composites', async () => {
 *         const run = await runCompScenario({ doc, ops: [{ seek: 1 }, { capture: 'a' }] });
 *         run.capture('a').expectLayerCount(2);
 *       });
 *     });
 *   });
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { currentBackend, TEST_BASE_URL } from './gpu-test-helpers';

/** Path to the comp_test_runner CLI built by the native CMake project. */
const NATIVE_COMP_RUNNER = path.resolve(
  __dirname, '..', '..', 'native', 'build', 'comp_test_runner',
);

// ── The shared contract (kept in sync with src/comp-test-runner.ts and
//    native/tools/comp_test_runner.mm) ──────────────────────────────────────

export type CompOp =
  | { seek: number }
  | { play: { frames: number; dtSec?: number } }
  | { launch: { trackId: string; sceneId: string; mode?: 'instant' | 'loose' } }
  | { stopScene: { trackId: string } }
  | { setParam: { ownerId: string; deviceId: string; field: string; value: unknown } }
  | { trackLevel: { trackId: string; level: number } }
  | { bypass: { id: string; on: boolean } }
  | { capture: string };

export interface CompScenario {
  doc: Record<string, unknown>;
  width?: number;
  height?: number;
  /** Precise transport (stalls on unready video). Default: fluid. */
  precise?: boolean;
  /**
   * Library roots a clip's `source.ref` resolves against — NATIVE ONLY. A saved
   * document carries no runtime `source.url`, so the native host has to locate
   * the media itself (bridge/comp_media_resolver.h). The web runner ignores
   * this: on web the store has already relinked and filled `url` in.
   */
  libraries?: { id: string; label?: string; absolutePath: string }[];
  ignoreSolo?: boolean;
  ops: CompOp[];
}

export interface RGBA { r: number; g: number; b: number; a: number }

interface RawCapture {
  pixelsBase64: string;
  width: number;
  height: number;
  samples: { x: number; y: number; r: number; g: number; b: number; a: number }[];
  hasContent: boolean;
  holding: boolean;
  positionBeat: number;
  positionSec: number;
  layerCount: number;
  chainKeys: string[];
  sceneStates: Record<string, any>;
  pendingScenes: Record<string, any>;
}

interface RawResult {
  success: boolean;
  error?: string;
  width: number;
  height: number;
  captures: Record<string, RawCapture>;
}

// ── Assertion surface ──────────────────────────────────────────────────────

/** One named capture, with the pixel helpers the comp suites actually need. */
export class CompCapture {
  readonly pixels: Uint8Array;
  constructor(readonly name: string, private readonly raw: RawCapture) {
    this.pixels = raw.pixelsBase64
      ? new Uint8Array(Buffer.from(raw.pixelsBase64, 'base64'))
      : new Uint8Array(0);
  }

  get width() { return this.raw.width; }
  get height() { return this.raw.height; }
  get hasContent() { return this.raw.hasContent; }
  get holding() { return this.raw.holding; }
  get positionBeat() { return this.raw.positionBeat; }
  get positionSec() { return this.raw.positionSec; }
  get layerCount() { return this.raw.layerCount; }
  get chainKeys() { return this.raw.chainKeys; }
  /** {trackId: {sceneId, launchBeat}} for every launched scene. */
  get sceneStates() { return this.raw.sceneStates ?? {}; }
  /** trackId → incoming scene while a gapless handover is still deferred. */
  get pendingScenes() { return this.raw.pendingScenes ?? {}; }

  /** The scene currently playing on `trackId`, or null. */
  playingScene(trackId: string): string | null {
    const s = this.sceneStates[trackId];
    return s && typeof s.sceneId === 'string' ? s.sceneId : null;
  }

  pixelAt(x: number, y: number): RGBA {
    const o = (y * this.width + x) * 4;
    if (o + 3 >= this.pixels.length) {
      throw new Error(`${this.name}: (${x},${y}) out of range (${this.width}x${this.height})`);
    }
    return {
      r: this.pixels[o], g: this.pixels[o + 1],
      b: this.pixels[o + 2], a: this.pixels[o + 3],
    };
  }

  centerPixel(): RGBA {
    return this.pixelAt(this.width >> 1, this.height >> 1);
  }

  /** Rec.601 luma of the centre pixel — what the monitor-sampling suites
   *  were really measuring when they read the canvas. */
  centerLuma(): number {
    const p = this.centerPixel();
    return Math.round(0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
  }

  /** Mean luma over the whole frame (robust to a single odd texel). */
  meanLuma(): number {
    if (this.pixels.length === 0) return 0;
    let sum = 0;
    const n = this.pixels.length / 4;
    for (let i = 0; i < this.pixels.length; i += 4) {
      sum += 0.299 * this.pixels[i] + 0.587 * this.pixels[i + 1] + 0.114 * this.pixels[i + 2];
    }
    return sum / n;
  }

  /**
   * Luma spread over an interior `n`×`n` sample grid — the "is this frame
   * spatially varied?" measure the monitor-sampling suites used. A flat fill
   * (e.g. a gray stand-in where a real effect should have run) reads ≈0.
   * Samples the interior only, so edge clamping can't manufacture a spread.
   */
  lumaSpread(n = 5): number {
    if (this.pixels.length === 0) return 0;
    const ls: number[] = [];
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= n; j++) {
        const x = Math.min(this.width - 1, Math.floor((this.width * i) / (n + 1)));
        const y = Math.min(this.height - 1, Math.floor((this.height * j) / (n + 1)));
        const p = this.pixelAt(x, y);
        ls.push(0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
      }
    }
    return Math.max(...ls) - Math.min(...ls);
  }

  /** Fraction of pixels satisfying `pred`. */
  coverage(pred: (c: RGBA) => boolean): number {
    if (this.pixels.length === 0) return 0;
    let hit = 0;
    const n = this.pixels.length / 4;
    for (let i = 0; i < this.pixels.length; i += 4) {
      if (pred({ r: this.pixels[i], g: this.pixels[i + 1], b: this.pixels[i + 2], a: this.pixels[i + 3] })) hit++;
    }
    return hit / n;
  }

  /** Byte-count difference against another capture (0 ⇒ identical frames). */
  diffBytes(other: CompCapture): number {
    if (this.pixels.length !== other.pixels.length) return Math.max(this.pixels.length, other.pixels.length);
    let d = 0;
    for (let i = 0; i < this.pixels.length; i++) if (this.pixels[i] !== other.pixels[i]) d++;
    return d;
  }

  expectPixelAt(x: number, y: number, want: Partial<RGBA>, tol = 2): void {
    const got = this.pixelAt(x, y);
    for (const k of ['r', 'g', 'b', 'a'] as const) {
      if (want[k] === undefined) continue;
      if (Math.abs(got[k] - want[k]!) > tol) {
        throw new Error(
          `${this.name}: pixel (${x},${y}).${k} = ${got[k]}, want ${want[k]} ±${tol} ` +
          `(got rgba ${got.r},${got.g},${got.b},${got.a})`);
      }
    }
  }

  expectLayerCount(n: number): void {
    if (this.layerCount !== n) {
      throw new Error(
        `${this.name}: layerCount ${this.layerCount}, want ${n} (chainKeys: ${this.chainKeys.join(', ')})`);
    }
  }
}

export class CompRun {
  constructor(private readonly raw: RawResult, readonly backend: string) {}

  get success() { return this.raw.success; }
  get error() { return this.raw.error; }
  get captureNames() { return Object.keys(this.raw.captures); }

  capture(name: string): CompCapture {
    const c = this.raw.captures[name];
    if (!c) {
      throw new Error(
        `capture '${name}' not found. Available: ${this.captureNames.join(', ') || '(none)'}`);
    }
    return new CompCapture(name, c);
  }

  /** Every capture whose name starts with `prefix`, in scenario order. */
  captures(prefix: string): CompCapture[] {
    return this.captureNames
      .filter((n) => n.startsWith(prefix))
      .map((n) => this.capture(n));
  }
}

// ── Runners ────────────────────────────────────────────────────────────────

function runMetalScenario(scenario: CompScenario): RawResult {
  if (!fs.existsSync(NATIVE_COMP_RUNNER)) {
    throw new Error(
      `comp_test_runner not found at ${NATIVE_COMP_RUNNER}.\n` +
      `Build it first: cmake --build native/build --target comp_test_runner`);
  }
  const child = spawnSync(NATIVE_COMP_RUNNER, [], {
    input: JSON.stringify(scenario),
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.error) {
    throw new Error(`comp_test_runner spawn failed: ${child.error.message}`);
  }
  if (!child.stdout) {
    throw new Error(`comp_test_runner exited ${child.status} with no output\nstderr: ${child.stderr}`);
  }
  try {
    return JSON.parse(child.stdout) as RawResult;
  } catch (e) {
    throw new Error(
      `comp_test_runner produced invalid JSON: ${String(e)}\nstdout: ${child.stdout.slice(0, 500)}`);
  }
}

/** Navigate to the runner page ONCE per jest worker — booting the engine costs
 *  a worker + a WebGPU device + a full bundle warm (seconds). */
let runnerPageReady = false;

export async function ensureCompRunnerPage(): Promise<void> {
  if (runnerPageReady) return;
  await page.goto(`${TEST_BASE_URL}/comp-test-runner.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!(window as any).__compRun, { timeout: 30_000 });
  runnerPageReady = true;
}

/** Force a re-navigation before the next scenario (e.g. after a page crash). */
export function resetCompRunnerPage(): void {
  runnerPageReady = false;
}

async function runPuppeteerScenario(scenario: CompScenario): Promise<RawResult> {
  await ensureCompRunnerPage();
  return await page.evaluate(
    async (scn: any) => await (window as any).__compRun(scn),
    scenario as any,
  ) as RawResult;
}

/**
 * Run a scenario on the ambient backend and return its captures. Throws with
 * the runner's own message when the scenario itself failed, so a broken
 * document surfaces as a real error rather than an empty capture set.
 */
export async function runCompScenario(scenario: CompScenario): Promise<CompRun> {
  const backend = currentBackend();
  const raw = backend === 'metal'
    ? runMetalScenario(scenario)
    : await runPuppeteerScenario(scenario);
  if (!raw.success) {
    throw new Error(`[${backend}] comp scenario failed: ${raw.error ?? 'unknown error'}`);
  }
  return new CompRun(raw, backend);
}

export { forEachBackend, setBackend, currentBackend } from './gpu-test-helpers';
