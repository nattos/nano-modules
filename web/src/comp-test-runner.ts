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
import { CompTestPump, type PumpClipTelemetry } from './comp-test-pump';
import { thumbnailController } from './views/arrangement/media/thumbnail-controller';

/** The comp executor publishes its output under this fixed sketch id. */
const COMPOSITE_ID = 'arr-composite';

// ── The shared contract (kept in sync with comp_test_runner.mm) ────────────

export type CompOp =
  | { seek: number }
  | { play: { frames: number; dtSec?: number } }
  | { step: { frames: number; dtSec?: number } }
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
  /** Offline export mode — renders a planned frame grid instead of `ops`. */
  export?: { fps?: number; startBeat?: number; endBeat?: number };
}

/** One rendered export frame, summarised (the raw pixels stay on the GPU). */
export interface ExportFrameStat {
  index: number;
  beat: number;
  meanLuma: number;
  hasContent: boolean;
}

export interface ExportResult {
  fps: number;
  frames: number;
  /** Frames the composite actually had content for. */
  engineFrames: number;
  durationSec: number;
  frameStats: ExportFrameStat[];
}

/** One clip's resolved transport row — what its controller effect published. */
export interface TransportRow {
  /** null when the row is INVALID (the section instance isn't live yet). NaN
   *  serialises to null through JSON on both hosts, so the shape agrees. */
  timeSec: number | null;
  active: number;
  rate: number | null;
  ended: number;
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
  transport: Record<string, TransportRow>;
  videoDescs: Record<string, unknown>[];
}

export interface CompRunResult {
  success: boolean;
  error?: string;
  width: number;
  height: number;
  captures: Record<string, CompCapture>;
  /** Decode telemetry, cumulative over the run (native: the `video` block). */
  video?: {
    clips: Record<string, PumpClipTelemetry>;
    /** Clip ids nothing could decode, with the reason — never a silent hole. */
    skipped: Record<string, string>;
    frames: number;
    /** Frames the Precise transport refused to advance because a clip's media
     *  wasn't decoded yet — the stall metric. */
    stalledFrames: number;
  };
  export?: ExportResult;
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
/**
 * And the decode-pump desc set — same story, and it bites HARDER: the pump is
 * rebuilt per scenario, so a scenario re-running a document the engine already
 * has built would report no change, hand its fresh pump nothing, and silently
 * render no video at all while every other assertion still passed.
 */
let liveVideoDescs = '[]';
/** And the transport ROW ORDER, which only rides a frame on
 *  kCompTransportSetChanged. The times themselves ride every frame that has
 *  rows at all, so they need no mirror — but they do need clearing when the
 *  driven set empties, which is why the assignment below is unconditional. */
let liveTransportOrder: string[] = [];
let liveTransportTimes: Float64Array = new Float64Array(0);

/**
 * Fold the stride-8 times channel into the per-clip rows the capture reports.
 * Mirrors `transportJson()` in comp_test_runner.mm, INCLUDING the NaN → null
 * mapping: nlohmann serialises NaN as null, and this result crosses a
 * structured clone (which would preserve NaN), so the mapping has to be
 * explicit here or the two backends would disagree on an invalid row.
 */
function transportRowsFrom(
  order: string[], times: Float64Array,
): Record<string, TransportRow> {
  const out: Record<string, TransportRow> = {};
  const nz = (v: number) => (Number.isNaN(v) ? null : v);
  for (let i = 0; i < order.length && i * 8 + 8 <= times.length; i++) {
    out[order[i]] = {
      timeSec: nz(times[i * 8]),
      active: times[i * 8 + 1],
      rate: nz(times[i * 8 + 2]),
      ended: times[i * 8 + 7],
    };
  }
  return out;
}

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
    const bpm = (doc.meta as { baseBPM?: number } | undefined)?.baseBPM ?? 120;
    e.compLoadDoc(JSON.stringify(doc));
    e.setPaused(true);
    e.compControl({ op: 'pause' });
    // Fluid by default — a Precise hold only makes sense for a scenario whose
    // clips have media to wait on.
    e.compControl({ op: 'mode', precise: !!scenario.precise });
    e.compControl({ op: 'loop', enabled: false });
    e.compControl({ op: 'ignoreSolo', on: !!scenario.ignoreSolo });

    // The decode pump, rebuilt per scenario so its cache/classifier state can't
    // leak between them (the ENGINE is shared; the pump is cheap). videoReadyFeed
    // tells the Precise gate a pump exists — without it the gate assumes nobody
    // is decoding and never holds.
    const gpu = await thumbnailController.sharedGpu();
    const pump = new CompTestPump(
      gpu.gpuHost, gpu.device, gpu.service, width, height,
      (key, bmp) => e.setInstanceTexture(key, bmp),
      (clipId, isReady) => e.compControl({ op: 'videoReady', clipId, ready: isReady }),
    );
    e.compControl({ op: 'videoReadyFeed' });

    // Held in an object, not plain `let`s: they're written from the engine
    // callbacks, which TS's control-flow analysis can't see — reading them in
    // the op loop would narrow to `never`.
    const last: { info: CompFrameInfo | null } = { info: null };
    let elapsedSec = 0;
    let frames = 0;
    let stalledFrames = 0;

    let resolveFrame: ((info: CompFrameInfo | null) => void) | null = null;
    e.onCompInfo = (info) => { last.info = info; };
    e.onFrameSet = (bitmaps) => {
      // The bitmaps are checkerboarded and unusable for comparison — close them
      // so the page doesn't leak one per frame. Real pixels come from
      // readbackTrace at capture points.
      for (const id in bitmaps) bitmaps[id].close();
      const r = resolveFrame;
      resolveFrame = null;
      r?.(last.info);
    };

    /** Advance exactly one engine frame with a known dt, and wait for it. */
    const engineStep = (dtSec: number): Promise<void> => new Promise((res, rej) => {
      const timer = setTimeout(() => {
        resolveFrame = null;
        rej(new Error('engine frame timed out'));
      }, 30_000);
      resolveFrame = () => {
        clearTimeout(timer);
        if (last.info?.chainKeys) liveChainKeys = last.info.chainKeys;
        if (last.info?.scenes) liveScenes = JSON.parse(last.info.scenes);
        if (last.info?.scenesPending) livePendingScenes = JSON.parse(last.info.scenesPending);
        if (last.info?.videoDescs !== undefined) liveVideoDescs = last.info.videoDescs;
        if (last.info?.transportOrder) liveTransportOrder = last.info.transportOrder;
        liveTransportTimes = last.info?.transportTimes ?? new Float64Array(0);
        frames++;
        if (last.info?.holding) stalledFrames++;
        res();
      };
      // Pin the step size explicitly. `setTime` CANNOT pace a comp-mode step:
      // the comp transport owns the playhead and rewrites the worker's
      // `elapsed` from its own positionSec every frame, so the derived dt
      // collapses to 0 and the transport never advances.
      e.stepFrame(dtSec);
    });

    /**
     * One scenario frame: decode + inject for the position the LAST frame left
     * us at, then step.
     *
     * The one-frame lag is deliberate and MATCHED on both runners. Web can't do
     * better: the pump lives on the main thread and the engine's update+render
     * happen inside the worker, so a frame decoded now can only be sampled by
     * the next step (which is exactly the app's behaviour — its pump is async
     * off the frame report). Native could inject mid-frame, but then mid-play
     * pixels would differ by one decoded frame and the comparison would be
     * meaningless, so comp_test_runner.mm pumps before update for the same
     * reason. Consequence worth knowing when writing scenarios: a single step
     * after a seek renders BEFORE anything has been decoded — video scenarios
     * need at least two.
     */
    // ── Offline export ─────────────────────────────────────────────────────
    // Every frame is a seek to a PLANNED beat, fully resolved before it renders.
    // Because the target beat is known in advance this path injects the decoded
    // frame BEFORE the seek, rather than carrying the realtime lag below — the
    // same thing export-renderer.ts does, and the native runner's export block.
    //
    // Scope, matching the native twin: frame-accurate RENDERING only. No muxing;
    // that would test an encoder, not the compositor.
    if (scenario.export) {
      const fps = Math.max(1, scenario.export.fps ?? 30);
      const startBeat = Math.max(0, scenario.export.startBeat ?? 0);
      const endBeat = scenario.export.endBeat ?? 8;
      const secondsAt = (b: number) => b * (60 / Math.max(1, bpm));
      const beatAt = (s: number) => s / (60 / Math.max(1, bpm));
      const startSec = secondsAt(startBeat);
      const durSec = Math.max(0, secondsAt(Math.max(startBeat, endBeat)) - startSec);
      const total = Math.max(1, Math.round(durSec * fps));

      // Prime the desc set before the loop: it only rides a frame report, and
      // every export frame pumps BEFORE its step — so without this warm-up
      // frame 0 would render before anything had been decoded.
      e.compControl({ op: 'seek', beat: startBeat });
      await engineStep(0);

      const frameStats: ExportFrameStat[] = [];
      let engineFrames = 0;
      for (let i = 0; i < total; i++) {
        const tSec = startSec + i / fps;
        const beat = beatAt(tSec);
        await pump.setActiveClips(liveVideoDescs);
        await pump.pump(beat, bpm);
        e.compControl({ op: 'seek', beat });
        await engineStep(0);
        const raw = await e.readbackTrace(COMPOSITE_ID);
        const px = raw?.pixels ?? new Uint8Array(0);
        let lumaSum = 0;
        for (let o = 0; o + 3 < px.length; o += 4) {
          lumaSum += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
        }
        const hasContent = !!last.info?.hasContent;
        if (hasContent) engineFrames++;
        frameStats.push({
          index: i,
          beat,
          meanLuma: px.length ? lumaSum / (px.length / 4) : 0,
          hasContent,
        });
      }

      e.onFrameSet = null;
      e.onCompInfo = null;
      const exported: ExportResult = {
        fps, frames: total, engineFrames, durationSec: total / fps, frameStats,
      };
      const exportVideo = {
        clips: pump.telemetry(), skipped: pump.skipped, frames, stalledFrames,
      };
      await pump.dispose();
      return { success: true, width, height, captures, video: exportVideo, export: exported };
    }

    const step = async (dtSec: number): Promise<void> => {
      // From the page-scope mirror, not `last.info`: the desc set only rides a
      // frame when it CHANGED, and this pump is younger than the engine.
      await pump.setActiveClips(liveVideoDescs);
      if (last.info) await pump.pump(last.info.positionBeat, bpm);
      await engineStep(dtSec);
    };

    for (const op of scenario.ops) {
      if ('seek' in op) {
        e.compControl({ op: 'seek', beat: op.seek });
        await step(0);

      } else if ('play' in op) {
        const dt = op.play.dtSec ?? 1 / 60;
        e.compControl({ op: 'play' });
        for (let i = 0; i < op.play.frames; i++) await step(dt);
        e.compControl({ op: 'pause' });

      } else if ('step' in op) {
        // Paced frames with the transport left PAUSED. Distinct from `play` on
        // purpose: a step whose beat must NOT advance is the only way to tell a
        // frozen publisher from one merely sampled at the same phase each time.
        const dt = op.step.dtSec ?? 1 / 60;
        for (let i = 0; i < op.step.frames; i++) await step(dt);

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
          transport: transportRowsFrom(liveTransportOrder, liveTransportTimes),
          videoDescs: JSON.parse(liveVideoDescs || '[]'),
        };
      }
    }

    e.onFrameSet = null;
    e.onCompInfo = null;
    const video = { clips: pump.telemetry(), skipped: pump.skipped, frames, stalledFrames };
    await pump.dispose();
    const result: CompRunResult = { success: true, width, height, captures, video };
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
