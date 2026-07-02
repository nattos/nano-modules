/**
 * Engine worker — runs bridge core, WASM modules, and GPU rendering
 * off the main thread.
 *
 * simulateTick() runs the full composition each frame:
 * 1. Tick all real plugin instances
 * 2. Render real modules
 * 3. Execute sketch chains (virtual instances with texture routing)
 * 4. Capture trace point outputs as ImageBitmaps
 */

import { BridgeCore } from './bridge-core';
import { GPUHost } from './gpu-host';
import { TextEngine } from './text-engine';
import { WasmHost, WasmModule, type EffectInfo } from './wasm-host';
import { WasmSketchExecutor } from './executor-host';
import { TraceCapture } from './trace-capture';
import { traceBarrierKeys } from './engine-trace-barriers';
import type { WorkerCommand, WorkerEvent, EngineState, PluginInfo, TracePoint, DebugConsoleEntry } from './engine-types';
import { BUCKET_SKETCH_ID, chainEntryAt, normalizeSketchChains, sketchChain, type Sketch } from './sketch-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let bridgeCore: BridgeCore | null = null;
let gpuHost: GPUHost | null = null;
let gpuDevice: GPUDevice | null = null;
let canvas: OffscreenCanvas | null = null;
let gpuContext: GPUCanvasContext | null = null;
// The unified executor.wasm — the C++ sketch executor (the SAME binary the
// native barrel runs, via executor-host.ts), and the sole web executor. It drives
// sketch frames AND serves editor support (trace points, live plugin state,
// console logs, debug stats). The TS SketchExecutor it replaced has been retired.
let executor: WasmSketchExecutor | null = null;
let traceCapture: TraceCapture | null = null;

// Single accessor so cross-cutting reads stay terse.
function activeExecutor(): WasmSketchExecutor | null {
  return executor;
}

// True when the editor is bound to a remote NanoBarrel — the worker
// becomes editor-only: no simulateTick, no warmupEffects, no
// broadcastState. Plugin schemas come from the WS bridge instead.
let barrelMode = false;

// Real module instances
const realModules = new Map<string, { host: WasmHost; module: WasmModule }>();

// Registry of compiled WASM modules and their available effects
interface LoadedWasmModule {
  moduleId: string;    // e.g. "com.nano.core"
  compiled: WebAssembly.Module;
  effects: EffectInfo[];
}
const moduleRegistry = new Map<string, LoadedWasmModule>();

// Flattened effect registry: module-relative ID → { compiled, effect }
// "Last wins" — later registrations override earlier ones.
const effectRegistry = new Map<string, { compiled: WebAssembly.Module; effect: EffectInfo }>();

/** Resolve an effect ID that may be module-qualified or module-relative. */
/**
 * Build a bridge-core val handle from any of the legal `ParamValue`
 * runtime types. Bridge core models number / bool / string / array /
 * object natively; null/undefined map to valNull(). Returns null when
 * we can't represent the value at all.
 */
function makeBridgeVal(bc: BridgeCore, value: any): number | null {
  if (value === null || value === undefined) return bc.valNull();
  if (typeof value === 'number') return bc.valNumber(value);
  if (typeof value === 'boolean') return bc.valBool(value);
  if (typeof value === 'string') return bc.valString(value);
  if (Array.isArray(value)) {
    const arr = bc.valArray();
    for (const item of value) {
      const ih = makeBridgeVal(bc, item);
      if (ih == null) continue;
      bc.valPush(arr, ih);
      bc.valRelease(ih);
    }
    return arr;
  }
  if (typeof value === 'object') {
    const obj = bc.valObject();
    for (const [k, v] of Object.entries(value)) {
      const vh = makeBridgeVal(bc, v);
      if (vh == null) continue;
      bc.valSet(obj, k, vh);
      bc.valRelease(vh);
    }
    return obj;
  }
  return null;
}

function resolveEffectId(id: string): string {
  // If it's already in the registry as-is, it's module-relative
  if (effectRegistry.has(id)) return id;
  // Try stripping known module prefixes (e.g. "com.nano.core.composite.blend" → "composite.blend")
  for (const entry of moduleRegistry.values()) {
    const prefix = entry.moduleId + '.';
    if (id.startsWith(prefix)) {
      const relative = id.slice(prefix.length);
      if (effectRegistry.has(relative)) return relative;
    }
  }
  return id; // return as-is, caller handles "not found"
}

// Sketches
const sketches = new Map<string, Sketch>();


// Trace points
let tracePoints: TracePoint[] = [];

// Per-module render targets (one per real module instance)
const moduleRenderTargets = new Map<string, { tex: GPUTexture; handle: number }>();

// Per-sketch output texture handles (from current frame)
const sketchOutputs = new Map<string, number>();

// ── Composition executor (arrangement comp mode) ──
// When on, simulateTick drives the in-wasm comp executor each frame (its output
// lands in sketchOutputs under 'arr-composite', so trace capture is unchanged).
let compActive = false;
// How many discovered plugins have been seeded into the comp catalog — the comp
// executor needs every referenced module's schema BEFORE it evaluates the
// timeline (role/defaults). Re-checked each tick; new discoveries re-seed.
let compSeededPlugins = 0;
// The latest compFrame report, attached to the next 'frame' post.
let compFrameInfo: import('./engine-types').CompFrameInfo | null = null;

/** Seed the comp catalog from every discovered plugin (schema + capabilities),
 *  the same source broadcastState wraps into PluginInfo. Cheap when count is
 *  unchanged. */
function compSeedSchemas() {
  if (!executor || !bridgeCore) return;
  const entries = bridgeCore.getAt('/global')?.plugins as any[] | undefined;
  if (!entries || entries.length === compSeededPlugins) return;
  // Dedup by id, LAST entry wins (mirrors broadcastState's HMR rule).
  const byId = new Map<string, any>();
  for (const entry of entries) {
    const id = entry?.metadata?.id ?? entry?.key ?? '';
    if (id) byId.set(id, entry);
  }
  for (const [id, entry] of byId) {
    const schema = entry.schema ?? {};
    const caps = WasmHost.capabilitiesById.get(id) ?? [];
    executor.compRegisterSchema(id, JSON.stringify(schema), JSON.stringify(caps));
  }
  compSeededPlugins = entries.length;
}

// Render loop state
let running = false;
let frameInFlight = false;
// GPU frames-in-flight cap. `frameInFlight` only serializes the JS half of a
// frame; the GPU half (submitted command buffers) is never awaited, so under
// load the queue grows unbounded — memory climbs and you get periodic catch-up
// stalls. We record a completion fence per frame and, once more than this many
// are outstanding, block the loop until the oldest (frame N-MAX) finishes
// before issuing the next. This bounds queued GPU work to ~MAX frames and
// paces the loop to the GPU's real throughput when it can't keep up.
const MAX_FRAMES_IN_FLIGHT = 2;
let inFlightFences: Array<Promise<unknown>> = [];
let lastTime = 0;
let elapsed = 0;
// When non-null, the effect clock is driven by this external (transport) time
// instead of the free-running wall clock: elapsed := transportSeconds each
// frame, deltaTime := the change since last frame. Same value frame-to-frame
// (transport paused) ⇒ deltaTime 0 ⇒ a static frame. null ⇒ free-run.
let transportSeconds: number | null = null;
let frameCount = 0;
let fpsTime = 0;
let fps = 0;
// --- GPU-busy estimate (CPU-fence proxy) ---
// We can't yet read true GPU pass durations (no timestamp-query plumbing), so
// we approximate GPU busy-time by timing how long the queue takes to signal
// `onSubmittedWorkDone` from the moment we request the fence. Under the
// in-flight cap this completion lag includes pipeline backlog, so it stays near
// zero when the GPU is idle and climbs sharply toward (and past) the frame
// budget as it saturates — a usable headroom signal. `gpuTimeEma` smooths the
// raw samples; `gpuTimeReported` is refreshed at ~10 Hz (every 6th frame) so
// the readout doesn't churn the UI at frame rate. The headroom % itself is
// computed main-side against the user's target framerate. When real timestamp
// queries land, replace the `sample` source and keep the same reported field.
let gpuTimeEma = 0;
let gpuTimeReported = 0;
let gpuTimeTick = 0;
let stateGeneration = 0;
let lastBroadcastGeneration = -1;
let paused = false;
// While paused we tell the UI fps=0 exactly once (on entering pause) rather
// than posting an empty 'frame' every rAF — the per-frame post made the main
// thread churn mobx + re-render lit ~60×/s for nothing. Reset on resume.
let pausedFramePosted = false;
let debugStatsTick = 0; // throttles Debug Info panel updates to ~10 Hz
// When on, the next frame event carries DebugStats + recent
// console-log entries (for the Debug Info sidebar). Off by default —
// the toggle flips with `setDebugMode`.
let debugMode = false;
// Rolling buffer of recent console-log entries from any effect this
// frame and the last few. Cleared after each broadcast. Capped so a
// chatty effect can't drown the channel.
const DEBUG_CONSOLE_CAP = 200;
const debugConsoleBuffer: DebugConsoleEntry[] = [];

// Command queue
const pendingCommands: WorkerCommand[] = [];
let processing = false;

function post(event: WorkerEvent, transfer?: Transferable[]) {
  if (transfer) ctx.postMessage(event, transfer);
  else ctx.postMessage(event);
}

function markDirty() { stateGeneration++; }

async function processQueue() {
  if (processing) return;
  processing = true;
  while (pendingCommands.length > 0) {
    const cmd = pendingCommands.shift()!;
    await handleCommand(cmd);
  }
  processing = false;
}

async function handleCommand(cmd: WorkerCommand) {
  switch (cmd.type) {
    case 'init':
      barrelMode = !!cmd.barrelMode;
      await init(cmd.width, cmd.height);
      break;
    case 'resize':
      if (canvas) { canvas.width = cmd.width; canvas.height = cmd.height; }
      break;
    case 'loadModule':
      // In barrel mode the worker never instantiates effects. Schemas
      // come from the WS bridge.
      if (barrelMode) break;
      await loadModule(cmd.moduleType);
      break;
    case 'instantiateEffect':
      if (barrelMode) break;
      await instantiateEffect(cmd.effectId);
      break;
    case 'changeInstanceType': {
      const sketch = sketches.get(cmd.sketchId);
      if (sketch && executor) {
        const entry = sketchChain(sketch)[cmd.chainIdx];
        if (entry?.type === 'module') {
          // Update sketch data
          entry.module_type = cmd.newModuleType;
          if (sketch.instances?.[entry.instance_key]) {
            sketch.instances[entry.instance_key].module_type = cmd.newModuleType;
            sketch.instances[entry.instance_key].state = {};
          }
          // Invalidate the executor's cached instance so it reloads with the new type
          executor.invalidateInstance(entry.instance_key);
          markDirty();
        }
      }
      break;
    }
    case 'createSketch': {
      // Normalize on ingest → flattens any legacy `columns` into the canonical
      // single `chain` the executor runs.
      const s = normalizeSketchChains(cmd.sketch);
      sketches.set(cmd.sketchId, s);
      removeInstancesFromBucket(s);
      markDirty();
      break;
    }
    case 'updateSketch': {
      const s = normalizeSketchChains(cmd.sketch);
      sketches.set(cmd.sketchId, s);
      removeInstancesFromBucket(s);
      markDirty();
      break;
    }
    case 'deleteSketch': {
      sketches.delete(cmd.sketchId);
      // Drop the executor slot too (frees the native executor + instance pool) so
      // a later identical re-create runs from scratch instead of reviving a stale
      // time-independent instance that reports identity.
      executor?.deleteSketch(cmd.sketchId);
      // Free any user-injected input texture; the GPU pool reclaims memory.
      sketchInputTextures.delete(cmd.sketchId);
      // Trace points referencing this sketch are unregistered by the UI
      // (texture-monitor.disconnectedCallback) and don't need cleanup here.
      markDirty();
      break;
    }
    case 'setParam': {
      // In barrel mode the canonical state lives on the remote and the
      // controller's barrelPusher is the only sink that matters. The
      // worker has no live executor + no WasmHosts to patch.
      if (barrelMode) break;
      const sketch = sketches.get(cmd.sketchId);
      if (sketch) {
        const entry = sketchChain(sketch)[cmd.chainIdx];
        if (entry?.type === 'module') {
          // Update the instance state in the sketch (if instances map exists)
          if (sketch.instances?.[entry.instance_key]) {
            sketch.instances[entry.instance_key].state[cmd.paramKey] = cmd.value;
          }
          // Update the live instance immediately (direct-poke fast path: fire the
          // patch + commit to bridge core now rather than waiting for the next
          // frame's sketch-state applyState).
          if (executor) {
            const loaded = executor.getInstance(entry.instance_key);
            if (loaded) {
              loaded.host.notifyStatePatched(loaded.module, [
                { op: 'replace', path: cmd.paramKey, value: cmd.value },
              ]);
              // Commit to bridge core so pluginState stays in sync.
              // Bridge core only models scalars natively; for vec / array
              // / object payloads we round-trip through JSON.
              const bc = loaded.host.bridgeCore;
              const pk = loaded.host.pluginKey;
              if (bc && pk) {
                const vh = makeBridgeVal(bc, cmd.value);
                if (vh != null) {
                  bc.commitVal(pk, cmd.paramKey, vh);
                  bc.valRelease(vh);
                }
              }
            }
          }
        }
      }
      break;
    }
    case 'setTracePoints':
      tracePoints = cmd.tracePoints;
      break;
    case 'setPaused':
      paused = cmd.paused;
      // On resume, reset lastTime so the next frame's dt isn't a giant
      // catch-up jump that breaks animation smoothness. Re-arm the
      // one-shot paused indicator so the next pause re-notifies the UI.
      if (!paused) { lastTime = performance.now() / 1000; pausedFramePosted = false; }
      break;
    case 'setTime':
      transportSeconds = cmd.seconds;
      break;
    case 'stepFrame':
      await stepOneFrame();
      break;
    case 'setSketchInput':
      // Phase 7 wires this to the GPU; for now we just stash the bitmap so
      // it's available when that phase lands.
      handleSetSketchInput(cmd.sketchId, cmd.bitmap);
      break;
    case 'setInstanceTexture':
      handleSetInstanceTexture(cmd.instanceKey, cmd.bitmap);
      break;
    case 'reloadWasm':
      await reloadWasmModule(cmd.wasmUrl);
      break;
    case 'registerFont': {
      // Main thread resolved an OS font via Local Font Access; register its
      // bytes with the shared text engine so the next frame can use the face.
      const te = await TextEngine.whenReady();
      // Engine derives the faceKey from (family,weight,italic); Blitz matches by
      // family + weight + style so `font-family:"Monaco"` (incl. bold/italic) in
      // HTML/CSS resolves to the real OS face.
      if (te && te.registerOsFace(cmd.family, cmd.weight, cmd.italic, new Uint8Array(cmd.bytes)) >= 0) markDirty();
      break;
    }
    case 'registerFallback': {
      // Main thread resolved an OS CJK face via Local Font Access; append it to
      // the engine's fallback chain (and Blitz's) so the next frame shapes CJK.
      const te = await TextEngine.whenReady();
      if (te && te.registerFallbackBytes(new Uint8Array(cmd.bytes), cmd.lang) >= 0) markDirty();
      break;
    }
    case 'setFusionMode':
      executor?.setFusionMode(cmd.mode);
      break;
    case 'setAutomation':
      executor?.setAutomation(cmd.json);
      break;
    // ── Composition executor (arrangement comp mode) ──
    case 'compMode':
      compActive = !!cmd.on;
      if (compActive) {
        executor?.compEnable();
        compSeededPlugins = 0; // re-seed schemas on the next tick
      }
      break;
    case 'compLoadDoc':
      executor?.compLoadDocument(cmd.json);
      break;
    case 'compControl':
      executor?.compControl(cmd);
      break;
    case 'compOp':
      executor?.compOp(cmd);
      break;
    case 'setDebugMode':
      debugMode = !!cmd.on;
      // Clear the console buffer on toggle so the UI doesn't flash
      // with stale entries from before the user opened the tab.
      debugConsoleBuffer.length = 0;
      // Drain any debug stats so the next frame starts clean.
      executor?.consumeDebugStats();
      break;
    case 'requestFieldVisibility': {
      // Static visibility query (off the render path): resolve which fields the
      // effect hides for a candidate state, via its `eval_visibility` evaluator.
      // `hidden: null` means the effect declared no static evaluator.
      let hidden: string[] | null = null;
      try {
        const host = await evalHostForType(cmd.moduleType);
        hidden = host ? host.evaluateVisibility(cmd.state) : null;
      } catch (err) {
        console.warn(`[visibility] eval failed for ${cmd.moduleType}:`, err);
      }
      post({ type: 'fieldVisibility', reqId: cmd.reqId, hidden });
      break;
    }
    case 'debugDump': {
      const bridgeState = bridgeCore ? bridgeCore.getAt('/') : null;
      const sketchRecord: Record<string, any> = {};
      for (const [id, sketch] of sketches) sketchRecord[id] = sketch;

      const instanceInfo: Record<string, any> = {};
      const dumpExec = activeExecutor();
      if (dumpExec) {
        for (const [id, sketch] of sketches) {
          for (const entry of sketchChain(sketch)) {
              if (entry.type === 'module') {
                const loaded = dumpExec.getInstance(entry.instance_key);
                instanceInfo[entry.instance_key] = {
                  exists: !!loaded,
                  params: entry.params,
                  frameParams: loaded ? [...loaded.host.frameState.params] : null,
                  pluginState: loaded ? loaded.host.pluginState : null,
                };
              }
            }
        }
      }

      post({ type: 'debugDump', data: { bridgeState, sketches: sketchRecord, instances: instanceInfo } });
      break;
    }
  }
}

async function init(width: number, height: number) {
  // In barrel mode the worker is an editor-only stub. Skip GPU adapter
  // acquisition, bridge core, sketch executor — none of it is needed
  // because the worker never simulates, never instantiates effects, and
  // never publishes plugin state. The rAF loop is skipped too; the worker
  // just idles waiting for the (mostly no-op) command stream.
  if (barrelMode) {
    post({ type: 'ready' });
    return;
  }

  canvas = new OffscreenCanvas(width, height);

  bridgeCore = new BridgeCore();
  await bridgeCore.init();

  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    post({ type: 'error', message: 'No GPU adapter available' });
    return;
  }
  gpuDevice = await adapter.requestDevice();
  // Surface WebGPU validation errors to the console so E2E tests can
  // catch silent shader / bind-group breakage.
  gpuDevice.onuncapturederror = (e: any) => {
    console.error('[webgpu]', e.error?.message ?? e);
  };
  const format = 'rgba8unorm';

  gpuContext = canvas.getContext('webgpu') as GPUCanvasContext;
  // alphaMode: 'opaque' so the canvas presentation discards alpha at
  // blit. Internal pipeline keeps STRAIGHT alpha — bake_alpha and
  // video_blend assume non-premultiplied input/output. Mixing
  // 'premultiplied' canvas with straight-alpha shader math fringes
  // transparent pixels.
  gpuContext.configure({ device: gpuDevice, format, alphaMode: 'opaque' });

  gpuHost = new GPUHost(gpuDevice, format);
  // Initialize the shared text engine so text.* effects (source.text.plain) can render.
  // Idempotent; failures are non-fatal (effects that don't use text are fine).
  TextEngine.init(gpuDevice, { fontUrl: '/fonts/default.ttf' })
    .then((te) => {
      // queryLocalFonts is unavailable in the worker; ask the main thread to
      // resolve any unregistered family a spec names (it ships bytes back via
      // the registerFont command). One request per family per session.
      te.onFontRequest = (req) => post({ type: 'fontRequest', req });
    })
    .catch((e) => console.warn('[engine-worker] text engine init failed:', e));
  const ex = new WasmSketchExecutor(bridgeCore, gpuHost, gpuDevice, format, findCompiledModule);
  await ex.init();
  executor = ex;
  // Wire host-level schema-overlay changes (state::setFieldHidden) into
  // the worker's broadcast generation, so visibility edits show up in
  // the IDE on the next frame.
  executor.onHostSchemaChanged = () => markDirty();
  traceCapture = new TraceCapture(gpuDevice, format);

  post({ type: 'ready' });
  markDirty();

  running = true;
  lastTime = performance.now() / 1000;
  requestAnimationFrame(frame);
}

// ========================================================================
// Frame loop
// ========================================================================

async function frame() {
  if (!running || frameInFlight) return;
  frameInFlight = true;

  if (paused) {
    // Keep the loop alive but skip simulation. Posting fps=0 keeps the UI's
    // pause indicator reactive (consumers re-render as expected).
    //
    // Crucially we still drain pending state broadcasts here. Plugin
    // schemas, IO declarations, and hidden-field overlays can change
    // while paused (eg WASM HMR, the Effect IDE's setFieldHidden) and
    // the editor needs those updates to keep its inspector coherent.
    // Skipping broadcastState during pause silently strands the editor
    // on stale state — and used to also strand barrel mode's plugin
    // schemas behind a perma-paused engine inherited from another tab.
    if (stateGeneration !== lastBroadcastGeneration) {
      broadcastState();
      lastBroadcastGeneration = stateGeneration;
    }
    // Notify the UI we're paused (fps=0) exactly ONCE. Posting an empty
    // frame every rAF made the main thread re-run mobx + lit ~60×/s for
    // nothing — the dominant CPU cost while paused. A genuine state change
    // (HMR / setFieldHidden) still flows via broadcastState above.
    if (!pausedFramePosted) {
      pausedFramePosted = true;
      fps = 0;
      // No GPU work flows while paused — clear the estimate so the headroom
      // readout reads idle instead of freezing at the last live sample.
      gpuTimeEma = 0;
      gpuTimeReported = 0;
      post({
        type: 'frame',
        fps: 0,
        gpuTimeMs: 0,
        tracedFrames: {},
        sketchStateDiff: { changed: {}, removed: [] },
        pluginStatesDiff: { changed: {}, removed: [] },
        modulationDataDiff: { changed: {}, removed: [] },
      });
    }
    frameInFlight = false;
    requestAnimationFrame(frame);
    return;
  }

  const now = performance.now() / 1000;
  let dt: number;
  // Signed delta handed to the EXECUTOR only: a negative step (backward scrub) lets
  // seekable effects (e.g. the LFO) seek to the exact time instead of freezing. Real
  // modules + smoothing still get the clamped (≥0) `dt`.
  let execDt: number;
  if (transportSeconds != null) {
    // Transport-driven: the playhead time IS the effect time. Holding the same
    // seconds (paused) yields dt 0 → a static frame.
    execDt = transportSeconds - elapsed;
    dt = Math.max(0, execDt);
    elapsed = transportSeconds;
  } else {
    dt = execDt = now - lastTime;
    elapsed += dt;
  }
  lastTime = now;

  frameCount++;
  fpsTime += dt;
  if (fpsTime >= 1.0) {
    fps = frameCount;
    frameCount = 0;
    fpsTime = 0;
  }

  if (bridgeCore) bridgeCore.tick();

  await simulateTick(dt, execDt);
  captureAndSendFrame();

  if (stateGeneration !== lastBroadcastGeneration) {
    broadcastState();
    lastBroadcastGeneration = stateGeneration;
  }

  // Bound GPU frames-in-flight: record this frame's completion fence, and if
  // more than MAX are outstanding, wait for the oldest (frame N-MAX) before
  // the loop continues — so command buffers can't outrun the GPU.
  if (gpuDevice) {
    const submitTime = performance.now();
    const fence = gpuDevice.queue.onSubmittedWorkDone();
    // GPU-busy proxy: smooth the queue-completion lag (see gpuTimeEma decl).
    // Tolerate fence rejection (e.g. a transient device/instance drop) so it
    // never escapes as an unhandled rejection and the loop keeps running.
    void fence.then(() => {
      const sample = performance.now() - submitTime;
      gpuTimeEma = gpuTimeEma === 0 ? sample : gpuTimeEma * 0.85 + sample * 0.15;
    }).catch(() => {});
    inFlightFences.push(fence);
    if (inFlightFences.length > MAX_FRAMES_IN_FLIGHT) {
      try { await inFlightFences.shift(); } catch { /* dropped fence — keep looping */ }
    }
  }
  // Refresh the UI-facing GPU-time at ~10 Hz so the readout is stable.
  if (++gpuTimeTick % 6 === 0) gpuTimeReported = gpuTimeEma;

  frameInFlight = false;
  requestAnimationFrame(frame);
}

// Advance exactly one frame on demand (the IDE's frame-step button, sent while
// paused). Mirrors the live frame() body but uses a fixed nominal dt so a step
// is deterministic regardless of the wall-clock gap between clicks, and does
// NOT re-arm the rAF loop (the engine stays paused). Guarded by frameInFlight
// so it can't overlap an in-flight rAF frame.
async function stepOneFrame() {
  if (!running || frameInFlight) return;
  frameInFlight = true;
  try {
    // Transport-driven step (offline export / precise scrub): the requested
    // `transportSeconds` IS the effect time, so a step lands exactly on the
    // playhead at ANY fps (not a fixed 1/60). A negative execDt (backward step)
    // lets seekable effects seek; real modules + smoothing still get dt≥0.
    // No transport set ⇒ a fixed nominal 1/60 nudge (the IDE frame-step button).
    let dt: number;
    let execDt: number;
    if (transportSeconds != null) {
      execDt = transportSeconds - elapsed;
      dt = Math.max(0, execDt);
      elapsed = transportSeconds;
    } else {
      dt = execDt = 1 / 60;
      elapsed += dt;
    }

    if (bridgeCore) bridgeCore.tick();

    await simulateTick(dt, execDt);
    captureAndSendFrame();

    if (stateGeneration !== lastBroadcastGeneration) {
      broadcastState();
      lastBroadcastGeneration = stateGeneration;
    }

    if (gpuDevice) {
      inFlightFences.push(gpuDevice.queue.onSubmittedWorkDone());
      if (inFlightFences.length > MAX_FRAMES_IN_FLIGHT) {
        await inFlightFences.shift();
      }
    }
  } finally {
    frameInFlight = false;
  }
}

// ---- Sketch input frame source ----

/**
 * Per-sketch GPU input texture. Allocated lazily on first drop, reallocated
 * when the bitmap dimensions change. The bitmap itself is consumed (closed)
 * immediately after upload — repeat drops by the user re-decode + re-upload.
 */
const sketchInputTextures = new Map<string, { handle: number; width: number; height: number }>();

function handleSetSketchInput(sketchId: string, bitmap: ImageBitmap | null) {
  if (!bitmap) {
    sketchInputTextures.delete(sketchId);
    markDirty();
    return;
  }
  if (!gpuHost || !gpuDevice) {
    bitmap.close();
    return;
  }
  const w = bitmap.width;
  const h = bitmap.height;
  let entry = sketchInputTextures.get(sketchId);
  if (!entry || entry.width !== w || entry.height !== h) {
    // (Re)allocate. We don't try to release the old handle; gpuHost owns the
    // pool. Future cleanup can reclaim them if memory matters.
    const handle = gpuHost.createTexture(w, h, 1); // 1 = rgba8unorm
    entry = { handle, width: w, height: h };
    sketchInputTextures.set(sketchId, entry);
  }
  const tex = gpuHost.getTextureByHandle(entry.handle);
  if (tex) {
    gpuDevice.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture: tex },
      { width: w, height: h },
    );
  }
  bitmap.close();
  // NOTE: deliberately NOT markDirty(). Uploading an input texture changes
  // only the input image, not the inspector state (plugins / schemas /
  // sketch_state) that broadcastState ships. The frame loop already samples
  // the latest input texture every tick, so the canvas updates regardless.
  // A video/live source feeds this ~30-60×/s; calling markDirty() here used
  // to trigger a full /global JSON dump + plugins re-wrap + 'state' post
  // every input frame — the dominant CPU churn even when output was stopped.
}

/**
 * Per-instance host-injected frame textures (the arrangement video pump →
 * `source.video.file` chain entries). Keyed by the global instance key; the
 * decoded frame is bound to that instance's input slot 0 each tick (the
 * executor reads numeric texture field "0" to populate the slot).
 */
const instanceTextures = new Map<string, { handle: number; width: number; height: number }>();

function handleSetInstanceTexture(instanceKey: string, bitmap: ImageBitmap | null) {
  if (!bitmap) {
    instanceTextures.delete(instanceKey);
    activeExecutor()?.getInstance(instanceKey)?.host.textureFields.delete('0');
    return;
  }
  if (!gpuHost || !gpuDevice) {
    bitmap.close();
    return;
  }
  const w = bitmap.width;
  const h = bitmap.height;
  let entry = instanceTextures.get(instanceKey);
  if (!entry || entry.width !== w || entry.height !== h) {
    const handle = gpuHost.createTexture(w, h, 1); // rgba8unorm
    entry = { handle, width: w, height: h };
    instanceTextures.set(instanceKey, entry);
  }
  const tex = gpuHost.getTextureByHandle(entry.handle);
  if (tex) {
    gpuDevice.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture: tex },
      { width: w, height: h },
    );
  }
  bitmap.close();
  // Bind now (and re-bound each tick in applyInstanceTextures, since the instance
  // may not exist yet when the first frame arrives). No markDirty — same reasoning
  // as handleSetSketchInput (this is a per-frame video feed, not inspector state).
}

/** Re-bind injected frame textures onto their live instances (called per tick). */
function applyInstanceTextures() {
  const ex = activeExecutor();
  if (!ex || instanceTextures.size === 0) return;
  for (const [instanceKey, entry] of instanceTextures) {
    // Bind to input slot 0 (numeric field) — the executor reads this to populate
    // the instance's slot 0, which source.video.file reads via inputTexture(0).
    ex.getInstance(instanceKey)?.host.textureFields.set('0', entry.handle);
  }
}

/**
 * Simulate one frame of the entire composition.
 */
async function simulateTick(dt: number, execDt: number = dt) {
  if (!gpuHost || !gpuContext || !canvas || !executor) return;
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;

  const frameState = {
    elapsedTime: elapsed,
    deltaTime: dt,
    // Signed delta for the executor (backward scrub → effect seek); real modules
    // read `deltaTime` (clamped ≥0). Equal except on a backward transport jump.
    execDeltaTime: execDt,
    barPhase: (elapsed * 120 / 60 / 4) % 1.0,
    bpm: 120,
    viewportW: w,
    viewportH: h,
    params: new Array(16).fill(0),
  };

  // The executor owns the editor-preview surface — chain-entry handles + the
  // monitored-entry set. (Non-null: guarded at the top of simulateTick.)
  const exec = executor;

  // Clear per-frame chain entry handles before executing sketches
  exec.chainEntryHandles.clear();

  // Refresh the set of traced chain entries from this frame's
  // tracePoints so the fusion planner knows which intermediate
  // stages of fused runs need their pixels persisted to a real
  // texture (rather than collapsed into in-register chaining).
  exec.tracedChainEntries.clear();
  for (const key of traceBarrierKeys(tracePoints)) exec.tracedChainEntries.add(key);

  // NOTE: A real module instance appearing in multiple sketches will only be
  // ticked/rendered once (by whichever sketch chain processes it first). The
  // second sketch will see stale output. Resolume handles this by cloning the
  // instance per-composition — we'll need to do the same eventually.

  // 1. Collect instance keys used by sketch chains so we don't double-render them
  const sketchInstanceKeys = new Set<string>();
  for (const [, sketch] of sketches) {
    for (const entry of sketchChain(sketch)) {
        if (entry.type === 'module') {
          sketchInstanceKeys.add(entry.instance_key);
        }
      }
  }

  // 2. Register real modules into the ACTIVE executor so it reuses them instead
  //    of instantiating a duplicate (matches under executor.wasm too).
  for (const [key, { host, module: mod }] of realModules) {
    if (sketchInstanceKeys.has(key)) {
      exec.registerInstance(key, host, mod);
    }
  }

  // 3. Tick + render anchor modules that aren't already in a sketch chain,
  //    so their output can feed as input to the chain.
  const realOutputs = new Map<string, number>();
  const anchorKeys = new Set<string>();
  for (const [, sketch] of sketches) {
    if (sketch.anchor) anchorKeys.add(sketch.anchor);
  }
  for (const key of anchorKeys) {
    if (sketchInstanceKeys.has(key)) continue; // Will be rendered by the executor
    const real = realModules.get(key);
    if (!real) continue;

    const { host, module: mod } = real;
    host.frameState.elapsedTime = frameState.elapsedTime;
    host.frameState.deltaTime = frameState.deltaTime;
    host.frameState.barPhase = frameState.barPhase;
    host.frameState.bpm = frameState.bpm;
    host.frameState.viewportW = w;
    host.frameState.viewportH = h;
    mod.tick(dt);

    const rt = ensureRenderTarget(key, w, h);
    gpuHost.setSurface(rt.tex, w, h);
    host.drawList = [];
    mod.render(w, h);
    realOutputs.set(key, rt.handle);
  }

  // 4. Execute sketch chains (modules in chains are ticked + rendered by the executor)
  applyInstanceTextures(); // bind injected video frames to their instances first
  sketchOutputs.clear();
  for (const [sketchId, sketch] of sketches) {
    let inputHandle = -1;
    if (sketch.anchor && realOutputs.has(sketch.anchor)) {
      inputHandle = realOutputs.get(sketch.anchor)!;
    }
    // User-injected input bitmap (drag-drop) takes priority over anchor.
    const userInput = sketchInputTextures.get(sketchId);
    if (userInput) inputHandle = userInput.handle;

    try {
      // Re-bind injected video textures AFTER the executor (re)creates this frame's
      // instances — a freshly-created instance (first frame, or after a slot rebuild)
      // has empty textureFields, so binding only beforehand leaves slot 0 unbound and
      // source.video.file renders transparent (a 1-frame flash of the layers beneath).
      const outputHandle = await exec.executeAllColumns(
        sketchId, sketch, inputHandle, frameState, w, h, applyInstanceTextures);
      // (debug) if (frameCount < 3) console.log(`[worker] sketch ${sketchId}: anchor=${sketch.anchor} outputHandle=${outputHandle}`);
      sketchOutputs.set(sketchId, outputHandle);
    } catch (err) {
      console.error(`[sketch ${sketchId}]`, err);
    }
  }
  // ── Composition executor (comp mode): drive the in-wasm compositor. Its
  // output lands under 'arr-composite' so the existing trace capture +
  // transferToImageBitmap machinery works unchanged.
  compFrameInfo = null;
  if (compActive) {
    compSeedSchemas();
    try {
      const r = await exec.compFrame(dt, frameState, w, h, applyInstanceTextures);
      if (r.hasContent && r.handle >= 0) sketchOutputs.set('arr-composite', r.handle);
      // The comp transport owns the playhead: keep the worker's host clock in
      // lock-step so JS-side host frameStates track the composition time.
      elapsed = r.positionSec;
      compFrameInfo = {
        hasContent: r.hasContent,
        structureChanged: r.structureChanged,
        holding: r.holding,
        positionBeat: r.positionBeat,
        positionSec: r.positionSec,
        ...(r.chainKeys ? { chainKeys: r.chainKeys } : {}),
        ...(r.videoDescs !== undefined ? { videoDescs: r.videoDescs } : {}),
      };
    } catch (err) {
      console.error('[comp]', err);
    }
  }

  // Free chain instances for entries that left every sketch this frame (bounds
  // WASM memory: the arrangement's combined composite chain churns as clips come
  // and go / are split — otherwise instances accumulate until OOM). The comp
  // executor's required keys must survive the prune too.
  const keepKeys = compActive
    ? new Set([...sketchInstanceKeys, ...exec.compRequiredKeys])
    : sketchInstanceKeys;
  exec.pruneInstancesExcept(keepKeys);

  // 5. Tick and render remaining real modules not used by any sketch or anchor
  for (const [key, { host, module: mod }] of realModules) {
    if (sketchInstanceKeys.has(key) || anchorKeys.has(key)) continue;

    host.frameState.elapsedTime = frameState.elapsedTime;
    host.frameState.deltaTime = frameState.deltaTime;
    host.frameState.barPhase = frameState.barPhase;
    host.frameState.bpm = frameState.bpm;
    host.frameState.viewportW = w;
    host.frameState.viewportH = h;
    mod.tick(dt);

    const rt = ensureRenderTarget(key, w, h);
    gpuHost.setSurface(rt.tex, w, h);
    host.drawList = [];
    mod.render(w, h);
    realOutputs.set(key, rt.handle);
  }

  // Drain console-log entries from sketch instances and real
  // modules into the engine-wide debug buffer. Cap the buffer so a
  // chatty effect can't blow memory; oldest entries fall off first.
  {
    const ex = activeExecutor();
    if (ex) for (const e of ex.drainConsoleLogs()) debugConsoleBuffer.push(e);
  }
  for (const [key, { host }] of realModules) {
    if (host.consoleLogs.length === 0) continue;
    const moduleId = host.metadata?.id ?? key;
    for (const entry of host.consoleLogs) {
      debugConsoleBuffer.push({
        instanceKey: key, moduleId,
        timestamp: entry.timestamp, level: entry.level,
        message: entry.message, data: entry.data,
      });
    }
    host.consoleLogs = [];
  }
  if (debugConsoleBuffer.length > DEBUG_CONSOLE_CAP) {
    debugConsoleBuffer.splice(0, debugConsoleBuffer.length - DEBUG_CONSOLE_CAP);
  }

  // 5. Resolve trace point handles
  for (const tp of tracePoints) {
    let handle = -1;
    if (tp.target.type === 'sketch_output') {
      handle = sketchOutputs.get(tp.target.sketchId) ?? -1;
    } else if (tp.target.type === 'plugin_output') {
      handle = realOutputs.get(tp.target.pluginKey) ?? -1;
    } else if (tp.target.type === 'chain_entry') {
      const key = `${tp.target.sketchId}/${tp.target.colIdx}/${tp.target.chainIdx}`;
      const entry = exec.chainEntryHandles.get(key);
      if (entry) {
        handle = tp.target.side === 'input' ? entry.input : entry.output;
      }
      // Generator-led chains (the arrangement's per-clip video chains) inject the
      // source frame straight into the chain entry's slot 0 (`source.video.file`
      // reads `inputTexture(0)`). When the resolved handle is unset (-1) — e.g. a
      // source fused as the first stage of a group has no materialized output —
      // fall back to that injected texture so the trace previews the actual video
      // frame instead of an empty (transparent) image. `instanceTextures` only
      // holds video-source instances, so this never fires for a plain effect.
      if (handle < 0) {
        const ce = chainEntryAt(sketches.get(tp.target.sketchId), tp.target.chainIdx);
        if (ce && ce.type === 'module') {
          const inj = instanceTextures.get(ce.instance_key);
          if (inj) handle = inj.handle;
        }
      }
    }
    const prevHandle = traceHandles.get(tp.id);
    if (prevHandle !== handle) {
      // (debug) console.log(`[worker] trace '${tp.id}' handle changed: ${prevHandle} → ${handle} (target: ${JSON.stringify(tp.target)})`);
    }
    traceHandles.set(tp.id, handle);
  }
}

function ensureRenderTarget(key: string, w: number, h: number): { tex: GPUTexture; handle: number } {
  let rt = moduleRenderTargets.get(key);
  if (!rt || rt.tex.width !== w || rt.tex.height !== h) {
    rt?.tex.destroy();
    const tex = gpuDevice!.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      // COPY_SRC|COPY_DST superset so these can be copy endpoints (the executor's
      // intermediate pool copies into/out of these).
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
        | GPUTextureUsage.COPY_DST,
    });
    const handle = gpuHost!.injectTexture(tex);
    rt = { tex, handle };
    moduleRenderTargets.set(key, rt);
  }
  return rt;
}

/** Resolved texture handles for each trace point (populated by simulateTick). */
const traceHandles = new Map<string, number>();

// Per-key stringified baseline for cheap frame-to-frame diffing of the
// sketch_state / pluginStates maps. We ship only changed + removed keys so
// the main thread merges deltas (mobx set/remove) instead of re-wrapping the
// whole state every frame.
let lastSketchJson: Record<string, string> = {};
let lastPluginJson: Record<string, string> = {};
let lastModulationJson: Record<string, string> = {};

/**
 * Diff `cur` (a flat map keyed by instance/plugin key) against `baseline`
 * (per-key JSON), MUTATING `baseline` to match, and return the
 * {changed, removed} delta. Compared by JSON string, so unchanged keys
 * produce nothing even though `getAt` returns fresh object refs each frame.
 */
function diffMap(baseline: Record<string, string>, cur: Record<string, any>):
    import('./engine-types').StateDiff {
  const changed: Record<string, any> = {};
  const seen = new Set<string>();
  for (const k in cur) {
    seen.add(k);
    const j = JSON.stringify(cur[k]);
    if (baseline[k] !== j) { changed[k] = cur[k]; baseline[k] = j; }
  }
  const removed: string[] = [];
  for (const k in baseline) {
    if (!seen.has(k)) { removed.push(k); delete baseline[k]; }
  }
  return { changed, removed };
}

/**
 * Capture each trace point by blitting its texture to an OffscreenCanvas
 * and calling transferToImageBitmap(). Fully GPU-resident — no CPU readback.
 */
function captureAndSendFrame() {
  if (!gpuHost || !traceCapture) return;

  const tracedFrames: Record<string, ImageBitmap> = {};
  const transfers: Transferable[] = [];

  const sketchStateFull = bridgeCore?.getAt('/sketch_state') ?? {};

  // Collect live pluginState for all instances (sketch executor + real modules)
  const pluginStatesFull: Record<string, any> = activeExecutor()?.getPluginStates() ?? {};
  for (const [key, { host }] of realModules) {
    if (!(key in pluginStatesFull) && host.pluginState && Object.keys(host.pluginState).length > 0) {
      pluginStatesFull[key] = host.pluginState;
    }
  }

  // Diff vs. the last frame and ship only what changed. At steady state
  // both diffs are empty, so the main thread does zero mobx/lit work and
  // the postMessage payload is tiny. (Previously we shipped the full
  // sketch_state + every pluginState every frame, which the main thread
  // re-wrapped into deep observables — the dominant CPU cost in the trace.)
  const sketchStateDiff = diffMap(lastSketchJson, sketchStateFull);
  const pluginStatesDiff = diffMap(lastPluginJson, pluginStatesFull);

  // Per-modulated-input effective value + swing band (executor-computed). Diffed
  // like pluginStates; drives the slider modulation overlay.
  const modulationDataFull: Record<string, any> = activeExecutor()?.getModulationData() ?? {};
  const modulationDataDiff = diffMap(lastModulationJson, modulationDataFull);

  // Drain debug stats every frame so counters reset and each sample is a
  // true single-frame count. Forward to the UI only every 6th frame (~10
  // Hz): the Debug Info panel re-renders on each update, and 60 Hz stat
  // flicker is both unreadable and the main remaining per-frame lit cost
  // when the panel is open. Throttling here keeps the panel responsive
  // without re-rendering it 60×/s.
  const stats = activeExecutor()?.consumeDebugStats();
  const sendDebug = debugMode && (++debugStatsTick % 6 === 0);
  const debugStats = sendDebug ? stats : undefined;
  // Same for the console buffer — drain unconditionally (so the cap
  // bounds memory) but only ship when debug mode is on.
  let debugConsoleLog: import('./engine-types').DebugConsoleEntry[] | undefined;
  if (debugConsoleBuffer.length > 0) {
    if (debugMode) debugConsoleLog = debugConsoleBuffer.slice();
    debugConsoleBuffer.length = 0;
  }

  if (tracePoints.length === 0 || traceHandles.size === 0) {
    post({ type: 'frame', fps, gpuTimeMs: gpuTimeReported, tracedFrames, sketchStateDiff, pluginStatesDiff, modulationDataDiff, debugStats, debugConsoleLog, ...(compFrameInfo ? { comp: compFrameInfo } : {}) }, []);
    return;
  }

  for (const tp of tracePoints) {
    const handle = traceHandles.get(tp.id) ?? -1;
    if (handle < 0) continue;

    const srcTex = gpuHost.getTextureByHandle(handle);
    if (!srcTex) continue;

    try {
      const bitmap = traceCapture.capture(tp.id, srcTex, tp.size);
      tracedFrames[tp.id] = bitmap;
      transfers.push(bitmap);
    } catch (e) {
      console.warn(`[trace ${tp.id}] capture failed:`, e);
    }
  }

  post({ type: 'frame', fps, gpuTimeMs: gpuTimeReported, tracedFrames, sketchStateDiff, pluginStatesDiff, modulationDataDiff, debugStats, debugConsoleLog, ...(compFrameInfo ? { comp: compFrameInfo } : {}) }, transfers);
}

// ========================================================================
// Module loading
// ========================================================================

/** Find the compiled WebAssembly.Module that contains a given effect ID (module-relative or qualified). */
function findCompiledModule(effectId: string): { compiled: WebAssembly.Module; resolvedId: string } | null {
  if (!effectId) return null;
  const resolved = resolveEffectId(effectId);
  const entry = effectRegistry.get(resolved);
  if (!entry) return null;
  return { compiled: entry.compiled, resolvedId: resolved };
}

/**
 * HMR-driven module swap. Waits for the current frame to complete, evicts
 * the cached module + its registered effects, invalidates any live sketch
 * instances using those effects, then re-fetches and re-registers.
 *
 * Cache-busts the URL so the browser HTTP cache doesn't serve a stale .wasm.
 */
async function reloadWasmModule(wasmUrl: string) {
  const t0 = performance.now();
  console.log(`[wasm-hmr] worker received reload for ${wasmUrl}`);
  if (!bridgeCore || !gpuHost) {
    console.warn('[wasm-hmr] bridgeCore/gpuHost not initialised yet — ignoring reload');
    return;
  }

  // Wait for the in-flight frame to drain so we don't yank the rug from
  // under simulateTick. Bound the wait so a stuck frame doesn't deadlock.
  const drainStart = performance.now();
  const deadline = drainStart + 1000;
  while (frameInFlight && performance.now() < deadline) {
    await new Promise(r => setTimeout(r, 4));
  }
  const drainMs = (performance.now() - drainStart).toFixed(1);
  if (frameInFlight) {
    console.warn(`[wasm-hmr] frame still in flight after ${drainMs}ms; swapping anyway`);
  } else if (Number(drainMs) > 1) {
    console.log(`[wasm-hmr] drained in-flight frame in ${drainMs}ms`);
  }

  const loaded = moduleRegistry.get(wasmUrl);
  if (!loaded) {
    console.log(`[wasm-hmr] ${wasmUrl} not in moduleRegistry yet (no live consumer) — skipping`);
    return;
  }
  const moduleType = loaded.moduleId;
  const oldEffects = loaded.effects;
  const oldCompiled = loaded.compiled;
  const effectIds = new Set(oldEffects.map(e => e.id));
  console.log(`[wasm-hmr] swapping ${moduleType} (${oldEffects.length} effects: ${oldEffects.map(e => e.id).join(', ')})`);

  // Re-fetch + instantiate the new module FIRST. The old module stays
  // registered for the duration of this await, so any frame that runs
  // mid-load still finds the old effects and executes cleanly. The
  // registry swap below is synchronous, so there's no window where the
  // registries are empty.
  const cacheBustedUrl = `${wasmUrl}?t=${Date.now()}`;
  const host = new WasmHost();
  host.bridgeCore = bridgeCore;
  host.gpuHost = gpuHost;
  let compiled: WebAssembly.Module;
  let effects: EffectInfo[];
  const fetchStart = performance.now();
  try {
    await host.load(cacheBustedUrl);
    compiled = host.compiledModule!;
    effects = host.registeredEffects.map(e => ({ ...e }));
  } catch (e) {
    console.error(`[wasm-hmr] ✗ reload failed for ${wasmUrl}:`, e);
    post({ type: 'error', message: `Failed to reload ${wasmUrl}: ${e}` });
    return;
  }
  const fetchMs = (performance.now() - fetchStart).toFixed(1);

  // Atomic swap (all synchronous): evict old, install new, then
  // invalidate live instances so the executor picks them up on the
  // next frame.
  moduleRegistry.delete(wasmUrl);
  for (const e of oldEffects) {
    const reg = effectRegistry.get(e.id);
    if (reg && reg.compiled === oldCompiled) {
      effectRegistry.delete(e.id);
    }
  }
  moduleRegistry.set(wasmUrl, { moduleId: moduleType, compiled, effects });
  for (const effect of effects) {
    effectRegistry.set(effect.id, { compiled, effect });
  }

  let invalidatedCount = 0;
  // Sketch instances are keyed by entry.module_type, which the user
  // may have stored as either:
  //   - the registry-relative effect id ("motion.blur"), or
  //   - the fully-qualified bundle form ("com.nano.nano.motion.blur")
  // depending on how the sketch was built (legacy expandModulesList
  // produces relative; new auto-discovered effects in the IDE
  // tend to qualify). The `effectIds` set holds RELATIVE ids
  // (oldEffects came out of registerEffect at module-relative level),
  // so a strict .has() check would silently miss any sketch using
  // the qualified form — HMR loads the new module but rendering
  // sticks to the old WasmHost. Resolve before checking.
  const matchesReloadedModule = (moduleType: string) => {
    if (effectIds.has(moduleType)) return true;
    const resolved = resolveEffectId(moduleType);
    return resolved !== moduleType && effectIds.has(resolved);
  };

  if (executor) {
    for (const [, sketch] of sketches) {
      for (const entry of sketchChain(sketch)) {
          if (entry.type === 'module' && matchesReloadedModule(entry.module_type)) {
            executor.invalidateInstance(entry.instance_key);
            // Bug fix: dropping the instance alone leaves a STALE fused pipeline
            // (keyed by module-type sequence) in the dispatcher cache, so a fused
            // stage keeps running the old shader after HMR. Evict it too.
            executor.invalidateFusionCacheFor(resolveEffectId(entry.module_type));
            invalidatedCount++;
          }
        }
      }
  }

  // realModules holds direct-instantiation hosts (instantiateEffect
  // command, distinct from sketch chains). Their host.metadata.id is
  // the resolved relative form, so a direct .has() check is enough.
  // Drop+rebuild these too so the unassigned bucket stops rendering
  // stale shaders after HMR.
  let realRebuilt = 0;
  const realKeysToRebuild: string[] = [];
  for (const [key, { host }] of realModules) {
    const id = host.metadata?.id ?? '';
    if (effectIds.has(id)) realKeysToRebuild.push(key);
  }
  for (const key of realKeysToRebuild) {
    const old = realModules.get(key);
    if (!old) continue;
    realModules.delete(key);
    // Re-instantiate by id so a fresh host hooks into the new
    // compiled module. This re-uses the same key in spirit (a new
    // pluginKey is assigned, but the unassigned-bucket bookkeeping
    // doesn't depend on key stability across HMR).
    const id = old.host.metadata?.id ?? '';
    if (id) {
      // Fire-and-forget — instantiateEffect re-registers and updates
      // the bucket sketch. Errors land in the worker console.
      instantiateEffect(id).catch(err =>
        console.error(`[wasm-hmr] failed to rebuild direct instance ${id}:`, err));
      realRebuilt++;
    }
  }

  if (invalidatedCount === 0 && realRebuilt === 0) {
    console.warn(`[wasm-hmr] reload of ${moduleType} matched 0 live instances. ` +
                 `If rendering looks unchanged, verify your sketch's module_type ` +
                 `(${[...sketches.values()].flatMap(s => sketchChain(s))
                     .filter(e => e.type === 'module').map((e: any) => e.module_type).join(', ') || 'none'}) ` +
                 `against the reloaded effect ids (${[...effectIds].join(', ')}).`);
  } else {
    console.log(`[wasm-hmr] invalidated ${invalidatedCount} sketch instance(s) ` +
                `+ rebuilt ${realRebuilt} direct instance(s); ` +
                `they recreate on the next frame with persisted state replayed from the sketch`);
  }

  post({
    type: 'effectsDiscovered',
    effects: effects.map(e => ({
      id: e.id, name: e.name, description: e.description,
      category: e.category, keywords: e.keywords, bundle: moduleType,
      icon: e.icon, thumbnail: e.thumbnail,
    })),
  });
  markDirty();
  const totalMs = (performance.now() - t0).toFixed(1);
  console.log(`[wasm-hmr] ✔ reloaded ${wasmUrl} in ${totalMs}ms (fetch+instantiate ${fetchMs}ms, ${effects.length} effects: ${effects.map(e => e.id).join(', ')})`);
}

/**
 * Load a WASM module and discover its available effects.
 * Does NOT instantiate any effects — call instantiateEffect() separately.
 */
async function loadModule(moduleType: string) {
  if (!bridgeCore || !gpuHost) return;

  // Derive WASM filename from module type. We strip any
  // `com.<vendor>.` prefix (matches `com.nano.nano`, `com.nano.lights`,
  // etc) so the wasm file's short name is the last meaningful segment.
  const stripped = moduleType.replace(/^com\.[^.]+\./, '');
  const moduleName = stripped.replace(/\./g, '_');
  const wasmUrl = `/wasm/${moduleName}.wasm`;

  // Don't reload if already registered
  if (moduleRegistry.has(wasmUrl)) {
    const existing = moduleRegistry.get(wasmUrl)!;
    post({
      type: 'effectsDiscovered', effects: existing.effects.map(e => ({
        id: e.id, name: e.name, description: e.description,
        category: e.category, keywords: e.keywords, bundle: moduleType,
        icon: e.icon, thumbnail: e.thumbnail,
      }))
    });
    return;
  }

  const host = new WasmHost();
  host.bridgeCore = bridgeCore;
  host.gpuHost = gpuHost;

  try {
    await host.load(wasmUrl);

    const compiled = host.compiledModule!;
    const effects = host.registeredEffects.map(e => ({ ...e }));

    moduleRegistry.set(wasmUrl, { moduleId: moduleType, compiled, effects });

    // Populate the flat effect registry (last wins for override support)
    for (const effect of effects) {
      effectRegistry.set(effect.id, { compiled, effect });
    }

    // Broadcast discovered effects to the main thread
    post({
      type: 'effectsDiscovered', effects: effects.map(e => ({
        id: e.id, name: e.name, description: e.description,
        category: e.category, keywords: e.keywords, bundle: moduleType,
        icon: e.icon, thumbnail: e.thumbnail,
      }))
    });

    // Warm up each effect's schema. Each `activateEffect` instantiates
    // the WASM module afresh and runs the effect's `init`, which calls
    // the `set_schema` host import — which is what actually registers
    // the plugin (with its full schema and param defaults) in bridge
    // core's `/global/plugins`. Without this, the schema only lands
    // once a *sketch instance* runs the effect, and the editor can't
    // look up param defaults at drop-time (the standalone IDE got away
    // with it because the dev fixture sketches incidentally instantiate
    // a handful of effects; barrel mode doesn't).
    //
    // Each warmup host stays referenced in `warmupHosts` so it isn't
    // GC'd while bridge core still holds its plugin key. Memory cost
    // ~1-2 MB per effect, fine for our effect counts.
    await warmupEffects(compiled, effects);

    markDirty();
    // Push state immediately so the editor sees the newly-registered
    // plugin schemas even if the simulation frame loop hasn't ticked
    // yet (eg the engine is paused, or simulateTick is throwing on a
    // sketch that's missing an upstream module). Without this the
    // editor's `local.plugins` would stay empty until something else
    // bumped stateGeneration past lastBroadcastGeneration.
    broadcastState();
    lastBroadcastGeneration = stateGeneration;
  } catch (e) {
    post({ type: 'error', message: `Failed to load ${moduleType}: ${e}` });
  }
}

const warmupHosts: WasmHost[] = [];
// Warmup hosts indexed by resolved effect id, available for the FIRST
// instantiateEffect of that id to reuse (instead of spawning a second host).
// Each warmup ran `describeEffect` (module_init only), which already registered
// a `<id>@0` plugin key + schema — so the first instantiateEffect promotes THIS
// host to the live `@0` (just create()+init() on it), so plugin_output traces /
// metadata that reference `@0` resolve to the live, rendered instance. No
// instance exists at warmup (the schema is type-level); the host stays in
// warmupHosts[] so its plugin registration persists. Consumed entries are
// deleted so a 2nd instance of the same id correctly gets a fresh `@1` host.
const warmupByEffect = new Map<string, WasmHost>();

async function warmupEffects(compiled: WebAssembly.Module, effects: { id: string }[]) {
  for (const eff of effects) {
    try {
      const wh = new WasmHost();
      wh.bridgeCore = bridgeCore;
      wh.gpuHost = gpuHost;
      await wh.load(compiled);
      // Schema-only: run module_init (publishes the schema, registers the
      // plugin + `@0` key) WITHOUT standing up a rendering instance.
      wh.describeEffect(eff.id);
      warmupHosts.push(wh);
      warmupByEffect.set(eff.id, wh);
    } catch (err) {
      console.warn(`[warmup] schema registration failed for ${eff.id}:`, err);
    }
  }
}

// Dedicated, never-rendered hosts used only to answer static visibility
// queries for a type whose warmup host has already been promoted to a live
// instance (and removed from `warmupByEffect`). Lazily created, cached by type.
const visibilityHosts = new Map<string, WasmHost>();

/**
 * Resolve a host capable of answering a static visibility query for `moduleType`.
 * `eval_visibility` is self-less (pure over state), so ANY host of that type can
 * answer — preference order: a still-parked warmup host, a live instance, then a
 * dedicated lazily-built eval host. Returns null if the type isn't loaded.
 */
async function evalHostForType(moduleType: string): Promise<WasmHost | null> {
  const resolved = resolveEffectId(moduleType);
  // 1. A parked warmup host (already loaded + described for this exact effect;
  //    describeEffect resolved its self-less eval_visibility fn).
  const warm = warmupByEffect.get(resolved) ?? warmupByEffect.get(moduleType);
  if (warm) return warm;
  // 2. A live instance of this type (its host carries the same evaluator).
  for (const [key, v] of realModules) {
    if (key === `${resolved}@0` || key.startsWith(`${resolved}@`)) {
      if (v.host.evalVisibilityFn) return v.host;
    }
  }
  // 3. A dedicated eval host (cached) — only reached once the warmup host has
  //    been promoted to a live instance with no evaluator-bearing sibling.
  const cached = visibilityHosts.get(resolved);
  if (cached) return cached;
  const found = findCompiledModule(resolved);
  if (!found || !bridgeCore || !gpuHost) return null;
  try {
    const wh = new WasmHost();
    wh.bridgeCore = bridgeCore;
    wh.gpuHost = gpuHost;
    await wh.load(found.compiled);
    // Schema-only describe — a visibility host never renders, so it needs no
    // instance, just module_init + the resolved eval_visibility fn.
    wh.describeEffect(found.resolvedId);
    visibilityHosts.set(resolved, wh);
    return wh;
  } catch (err) {
    console.warn(`[visibility] failed to build eval host for ${moduleType}:`, err);
    return null;
  }
}

/**
 * Instantiate a specific effect and add it to the unassigned bucket sketch.
 * The effect's WASM module must already be loaded via loadModule().
 */
async function instantiateEffect(effectId: string) {
  if (!bridgeCore || !gpuHost) return;

  // Resolve module-qualified or module-relative ID
  const resolvedId = resolveEffectId(effectId);
  const found = findCompiledModule(resolvedId);
  if (!found) {
    post({ type: 'error', message: `Effect "${effectId}" not found in any loaded module` });
    return;
  }

  try {
    // Reuse the bundle-warmup host for the first instantiation of this effect
    // (already loaded + described as `<id>@0`), so the live instance is `@0`
    // rather than a fresh `@1`. Promotion only needs create()+init() — the
    // warmup host's module_init already ran, so activateEffect skips it and
    // just stands up the instance on the same `@0` plugin key. Subsequent
    // instantiations of the same id fall through to a fresh host.
    const warm = warmupByEffect.get(found.resolvedId);
    let host: WasmHost;
    let mod: WasmModule;
    if (warm) {
      warmupByEffect.delete(found.resolvedId);
      host = warm;
      mod = host.activateEffect(found.resolvedId);
    } else {
      host = new WasmHost();
      host.bridgeCore = bridgeCore;
      host.gpuHost = gpuHost;
      await host.load(found.compiled);
      mod = host.activateEffect(found.resolvedId);
    }

    const key = host.pluginKey || `${resolvedId}@0`;
    realModules.set(key, { host, module: mod });

    // Ensure the unassigned bucket sketch exists
    if (!sketches.has(BUCKET_SKETCH_ID)) {
      sketches.set(BUCKET_SKETCH_ID, {
        anchor: null,
        chain: [],
        instances: {},
      });
    }

    // Add instance to the bucket sketch (if not already in a real sketch)
    // Always store the module-relative ID in the data
    const bucket = sketches.get(BUCKET_SKETCH_ID)!;
    if (!isInstanceInAnySketch(key)) {
      bucket.instances = bucket.instances ?? {};
      bucket.instances[key] = {
        module_type: resolvedId,
        state: { ...host.pluginState },
      };
    }

    markDirty();
  } catch (e) {
    post({ type: 'error', message: `Failed to instantiate ${effectId}: ${e}` });
  }
}

/** Check if an instance key exists in any sketch's instances map. */
function isInstanceInAnySketch(instanceKey: string): boolean {
  for (const [, sketch] of sketches) {
    if (sketch.instances?.[instanceKey]) return true;
  }
  return false;
}

/** Remove instances that appear in a real sketch from the unassigned bucket. */
function removeInstancesFromBucket(sketch: Sketch) {
  const bucket = sketches.get(BUCKET_SKETCH_ID);
  if (!bucket?.instances) return;

  // Remove any instance that's referenced in this sketch's chain entries
  for (const entry of sketchChain(sketch)) {
      if (entry.type === 'module') {
        delete bucket.instances[entry.instance_key];
      }
    }
  // Also remove any instance in this sketch's instances map
  if (sketch.instances) {
    for (const key of Object.keys(sketch.instances)) {
      delete bucket.instances[key];
    }
  }
}

// ========================================================================
// State broadcast
// ========================================================================

function broadcastState() {
  if (!bridgeCore) return;
  // In barrel mode the worker has no plugins, no sketches, no sketch
  // state. Pushing an empty `state` snapshot here would clobber the
  // controller's barrel-supplied plugin list on the next round-trip.
  if (barrelMode) return;

  const globalData = bridgeCore.getAt('/global');
  const plugins: PluginInfo[] = [];

  if (globalData?.plugins) {
    // Bridge core assigns a fresh `<id>@N` key on every activation
    // and never compacts the list, so reloading a module via HMR (and
    // multiple live instances of the same effect type) leaves
    // duplicate entries in `globalData.plugins`. The UI keys plugin
    // metadata by `id`, so we dedup by id here and keep the LAST
    // entry — which, because registrations append, is the freshest
    // schema. Without this, the inspector keeps showing the previous
    // schema after HMR.
    const byId = new Map<string, any>();
    for (const entry of globalData.plugins) {
      const id = entry?.metadata?.id ?? entry?.key ?? '';
      if (!id) continue;
      byId.set(id, entry);
    }
    for (const entry of byId.values()) {
      // BridgeCore's native parser may not emit data_output io entries for
      // float fields with the Output flag. Merge ioDecls from the WasmHost
      // which correctly parses the schema on the JS side. Hosts may live in
      // either realModules (effects instantiated directly) or inside the
      // the executor (effects created via type-change or sketch load), so
      // match by pluginKey across both sources.
      let io: any[] = entry.io ?? [];
      let matchedHost = realModules.get(entry.key)?.host ?? null;
      const hostExec = activeExecutor();
      if (!matchedHost && hostExec) {
        for (const host of hostExec.allHosts()) {
          if (host.pluginKey === entry.key) { matchedHost = host; break; }
        }
      }
      if (matchedHost) {
        for (const decl of matchedHost.ioDecls) {
          if (!io.some((e: any) => e.name === decl.name && e.kind === decl.kind)) {
            io.push(decl);
          }
        }
      }

      // Apply the host's `hiddenFields` overlay onto the broadcast
      // schema. The schema in bridge core is full-fat (every field the
      // effect ever exposes); the host stamps `hidden:true` on the
      // ones the effect has currently marked hidden via
      // `state::setFieldHidden`. The IDE inspector skips hidden fields.
      let schema: any = entry.schema ?? matchedHost?.schema ?? {};
      if (matchedHost && matchedHost.hiddenFields.size > 0) {
        const overlaid: Record<string, any> = {};
        for (const [name, def] of Object.entries(schema)) {
          if (matchedHost.hiddenFields.has(name)) {
            overlaid[name] = { ...(def as any), hidden: true };
          } else {
            overlaid[name] = def;
          }
        }
        schema = overlaid;
      }

      plugins.push({
        key: entry.key,
        id: entry.metadata?.id ?? '',
        version: entry.metadata?.version
          ? `${entry.metadata.version.major}.${entry.metadata.version.minor}.${entry.metadata.version.patch}`
          : '0.0.0',
        moduleVersion: WasmHost.moduleVersionsById.get(entry.metadata?.id ?? '')
          ?? matchedHost?.moduleVersion ?? '0.0.0',
        params: (entry.params ?? []).map((p: any) => ({
          index: p.index,
          name: p.name,
          type: p.type,
          defaultValue: p.default ?? p.defaultValue ?? 0,
          min: p.min ?? 0,
          max: p.max ?? 1,
        })),
        io,
        schema,
        // Capabilities ride a static per-id map (captured at set_schema / loadModule
        // time) so DISCOVERED-but-not-instantiated effects — the whole palette — still
        // surface their tags (e.g. 'generator'); a live host, when present, wins.
        capabilities: matchedHost?.capabilities
          ?? WasmHost.capabilitiesById.get(entry.metadata?.id ?? '')
          ?? [],
        // Parameter groups: bridge core keeps only `fields`, so (like capabilities)
        // groups ride the live host / a static per-id map, not `entry.schema`.
        groups: matchedHost?.groups
          ?? WasmHost.groupsById.get(entry.metadata?.id ?? '')
          ?? {},
      });
    }
  }

  const sketchRecord: Record<string, Sketch> = {};
  for (const [id, sketch] of sketches) {
    sketchRecord[id] = sketch;
  }

  const sketchState = bridgeCore.getAt('/sketch_state') ?? {};
  post({ type: 'state', state: { plugins, sketches: sketchRecord, sketchState } });
}

// ========================================================================
// Message handler (queued)
// ========================================================================

ctx.onmessage = (e: MessageEvent<WorkerCommand>) => {
  pendingCommands.push(e.data);
  processQueue();
};
