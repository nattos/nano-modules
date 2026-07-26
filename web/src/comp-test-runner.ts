/**
 * comp-test-runner — headless `CompScenario` driver, the WEB half of the
 * dual-backend composition tests.
 *
 * Implements the same contract as `native/tools/comp_test_runner.mm`: a scenario
 * in, a `CompRunResult` out. One jest body can therefore drive both backends
 * through `forEachBackend`, exactly as the per-effect GPU tests already do.
 *
 * Drives `ArrEngine` DIRECTLY — paused, seek-stepped — the pattern
 * `export-renderer.ts` uses. Deliberately NOT the live `EngineBridge`: its
 * worker owns the transport and free-runs off the app's rAF ticker, so a
 * fixed-step comparison with native is impossible through it. Driving the
 * engine also keeps the store and the whole UI out of the parity path — the
 * document goes straight to `compLoadDoc`, just as the native runner hands it
 * to `loadDocument`.
 *
 * Pixels come back through `readbackTrace` (raw RGBA8 off the GPU), NOT through
 * the `onFrameSet` bitmaps: those go through TraceCapture, which composites over
 * the transparency checkerboard and forces alpha opaque — faithful for a
 * monitor, meaningless against a native `readbackTexture`.
 */

import { ArrEngine } from './views/arrangement/engine/arr-engine';
import { EFFECT_BUNDLES } from './effect-bundles';
import type { CompFrameInfo } from './engine-types';

/** The comp executor publishes its output under this fixed sketch id. */
const COMPOSITE_ID = 'arr-composite';

// ── The shared contract (kept in sync with comp_test_runner.mm) ────────────

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
  precise?: boolean;
  ignoreSolo?: boolean;
  ops: CompOp[];
}

export interface CompCapture {
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
  sceneStates: Record<string, unknown>;
  pendingScenes: Record<string, unknown>;
}

export interface CompRunResult {
  success: boolean;
  error?: string;
  width: number;
  height: number;
  captures: Record<string, CompCapture>;
}

// ── Helpers shared in spirit with the native runner ────────────────────────

function base64Encode(bytes: Uint8Array): string {
  // Chunked so a large frame can't blow the argument limit of String.fromCharCode.
  const chunks: string[] = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(chunks.join(''));
}

/**
 * Every `_blend` entry in the chain-keys readback — one is emitted per
 * composited layer (`clip_<id>_blend`). Computed IDENTICALLY in the native
 * runner: `engineBridge.layerCount()` can't be used here because it's a
 * store-side count of `compositeLayersAtBeat`, and the store isn't in this path.
 */
function layerCountFrom(chainKeys: string[]): number {
  return chainKeys.filter((k) => k.includes('_blend')).length;
}

/** Set `bypassed` on the clip/track with `id`, anywhere in the document. */
function setBypassedById(node: unknown, id: string, on: boolean): boolean {
  if (Array.isArray(node)) {
    for (const child of node) if (setBypassedById(child, id, on)) return true;
    return false;
  }
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (obj.id === id) {
    obj.bypassed = on;
    return true;
  }
  for (const key in obj) {
    const child = obj[key];
    if (child && typeof child === 'object' && setBypassedById(child, id, on)) return true;
  }
  return false;
}

// ── Runner ─────────────────────────────────────────────────────────────────

const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
const setStatus = (s: string) => { if (statusEl) statusEl.textContent = s; };

/** One engine per page, reused across scenarios (booting one costs a worker +
 *  a WebGPU device + a full bundle warm — seconds, not milliseconds). */
let engine: ArrEngine | null = null;
let enginePromise: Promise<ArrEngine> | null = null;

/**
 * The engine's CURRENT chain keys, tracked at page scope rather than per
 * scenario. `CompFrameInfo.chainKeys` only rides a frame when the structure
 * CHANGED (it's a per-frame JSON cost otherwise), and the engine persists
 * across scenarios — so a scenario that re-loads a document the engine already
 * has built raises no change and would otherwise see an empty key list. The
 * native runner doesn't hit this only because it's a fresh process per run.
 */
let liveChainKeys: string[] = [];
/** Same story for the launched-scene set: `CompFrameInfo.scenes` only rides a
 *  frame when it CHANGED, so it has to be tracked where the engine lives. */
let liveScenes: Record<string, unknown> = {};
let livePendingScenes: Record<string, unknown> = {};

async function ensureEngine(width: number, height: number): Promise<ArrEngine> {
  if (enginePromise) {
    const e = await enginePromise;
    e.resize(width, height);
    return e;
  }
  enginePromise = (async () => {
    setStatus('booting engine…');
    const e = new ArrEngine(width, height);
    e.onError = (m) => console.error('[comp-test-runner]', m);
    await e.ready;
    await e.warmBundles(EFFECT_BUNDLES);
    // Wait for effect discovery to SETTLE, not merely to be non-empty: the
    // worker seeds each discovered plugin's schema into the comp catalog before
    // the first update, and a module type that isn't in the catalog yet renders
    // a stand-in. Same guard the export path uses.
    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < 30_000) {
      const n = e.discovered.size;
      if (n > 0 && n === last) break;
      last = n;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (e.discovered.size === 0) throw new Error('effect discovery timed out');
    await e.compEnable(COMPOSITE_ID);
    engine = e;
    setStatus(`ready (${e.discovered.size} effects)`);
    return e;
  })();
  return enginePromise;
}

export async function runCompScenario(scenario: CompScenario): Promise<CompRunResult> {
  const width = scenario.width ?? 64;
  const height = scenario.height ?? 64;
  const captures: Record<string, CompCapture> = {};

  try {
    const e = await ensureEngine(width, height);

    // A scenario owns the whole transport: reset any launch state left behind
    // by the previous one, then mirror this document.
    e.compOp({ op: 'stopAllScenes' });
    liveScenes = {};
    livePendingScenes = {};
    const doc = JSON.parse(JSON.stringify(scenario.doc)) as Record<string, unknown>;
    e.compLoadDoc(JSON.stringify(doc));
    e.setPaused(true);
    e.compControl({ op: 'pause' });
    // Fluid by default: with no decode pump in this path there is nothing to
    // feed the Precise gate, and a held transport would freeze the beat.
    e.compControl({ op: 'mode', precise: !!scenario.precise });
    e.compControl({ op: 'loop', enabled: false });
    e.compControl({ op: 'ignoreSolo', on: !!scenario.ignoreSolo });

    // Held in an object, not plain `let`s: they're written from the engine
    // callbacks, which TS's control-flow analysis can't see — reading them in
    // the op loop would narrow to `never`.
    const last: { info: CompFrameInfo | null } = { info: null };
    let elapsedSec = 0;

    let resolveFrame: ((info: CompFrameInfo | null) => void) | null = null;
    e.onCompInfo = (info) => { last.info = info; };
    e.onFrameSet = (frames) => {
      // The bitmaps are checkerboarded and unusable for comparison — close them
      // so the page doesn't leak one per frame. Real pixels come from
      // readbackTrace at capture points.
      for (const id in frames) frames[id].close();
      const r = resolveFrame;
      resolveFrame = null;
      r?.(last.info);
    };

    /** Advance exactly one frame with a known dt, and wait for it to land. */
    const step = (dtSec: number): Promise<void> => new Promise((res, rej) => {
      const timer = setTimeout(() => {
        resolveFrame = null;
        rej(new Error('engine frame timed out'));
      }, 30_000);
      resolveFrame = () => {
        clearTimeout(timer);
        if (last.info?.chainKeys) liveChainKeys = last.info.chainKeys;
        if (last.info?.scenes) liveScenes = JSON.parse(last.info.scenes);
        if (last.info?.scenesPending) livePendingScenes = JSON.parse(last.info.scenesPending);
        res();
      };
      // Pin the step size explicitly. `setTime` CANNOT pace a comp-mode step:
      // the comp transport owns the playhead and rewrites the worker's
      // `elapsed` from its own positionSec every frame, so the derived dt
      // collapses to 0 and the transport never advances.
      e.stepFrame(dtSec);
    });

    for (const op of scenario.ops) {
      if ('seek' in op) {
        e.compControl({ op: 'seek', beat: op.seek });
        await step(0);

      } else if ('play' in op) {
        const dt = op.play.dtSec ?? 1 / 60;
        e.compControl({ op: 'play' });
        for (let i = 0; i < op.play.frames; i++) await step(dt);
        e.compControl({ op: 'pause' });

      } else if ('launch' in op) {
        e.compOp({
          op: 'launchScene',
          trackId: op.launch.trackId,
          sceneId: op.launch.sceneId,
          cls: op.launch.mode === 'loose' ? 1 : 0,
        });
        await step(0);

      } else if ('stopScene' in op) {
        e.compOp({ op: 'stopScene', trackId: op.stopScene.trackId });
        await step(0);

      } else if ('setParam' in op) {
        e.compOp({
          op: 'param',
          ownerId: op.setParam.ownerId,
          deviceId: op.setParam.deviceId,
          field: op.setParam.field,
          valueJson: JSON.stringify(op.setParam.value),
        });
        await step(0);

      } else if ('trackLevel' in op) {
        e.compOp({ op: 'trackLevel', trackId: op.trackLevel.trackId, level: op.trackLevel.level });
        await step(0);

      } else if ('bypass' in op) {
        if (!setBypassedById(doc, op.bypass.id, op.bypass.on)) {
          throw new Error(`bypass: no clip/track with id ${op.bypass.id}`);
        }
        // A structural edit is a document reload on both sides; the transport
        // position survives it, so re-seek to where we were.
        const beat = last.info?.positionBeat ?? 0;
        e.compLoadDoc(JSON.stringify(doc));
        e.compControl({ op: 'seek', beat });
        await step(0);

      } else if ('capture' in op) {
        await step(0);
        const raw = await e.readbackTrace(COMPOSITE_ID);
        const px = raw.pixels;
        const w = raw.width, h = raw.height;
        const samples: CompCapture['samples'] = [];
        const points: [number, number][] = w > 0 && h > 0
          ? [[w >> 1, h >> 1], [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]
          : [];
        for (const [x, y] of points) {
          const o = (y * w + x) * 4;
          if (o + 3 < px.length) {
            samples.push({ x, y, r: px[o], g: px[o + 1], b: px[o + 2], a: px[o + 3] });
          }
        }
        captures[op.capture] = {
          pixelsBase64: base64Encode(px),
          width: w,
          height: h,
          samples,
          hasContent: !!last.info?.hasContent,
          holding: !!last.info?.holding,
          positionBeat: last.info?.positionBeat ?? 0,
          positionSec: last.info?.positionSec ?? 0,
          layerCount: layerCountFrom(liveChainKeys),
          chainKeys: liveChainKeys,
          sceneStates: liveScenes,
          pendingScenes: livePendingScenes,
        };
      }
    }

    e.onFrameSet = null;
    e.onCompInfo = null;
    const result: CompRunResult = { success: true, width, height, captures };
    if (outEl) outEl.textContent = JSON.stringify({ ...result, captures: Object.keys(captures) }, null, 1);
    return result;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      width,
      height,
      captures,
    };
  }
}

(window as any).__compRun = runCompScenario;
(window as any).__compRunner = {
  run: runCompScenario,
  get engine() { return engine; },
  get ready() { return engine !== null; },
};
setStatus('idle — call window.__compRun(scenario)');
