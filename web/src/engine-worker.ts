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
import { WasmHost, WasmModule } from './wasm-host';
import { SketchExecutor } from './sketch-executor';
import { TraceCapture } from './trace-capture';
import type { WorkerCommand, WorkerEvent, EngineState, PluginInfo, TracePoint } from './engine-types';
import type { Sketch } from './sketch-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let bridgeCore: BridgeCore | null = null;
let gpuHost: GPUHost | null = null;
let gpuDevice: GPUDevice | null = null;
let canvas: OffscreenCanvas | null = null;
let gpuContext: GPUCanvasContext | null = null;
let sketchExecutor: SketchExecutor | null = null;
let traceCapture: TraceCapture | null = null;

// Real module instances
const realModules = new Map<string, { host: WasmHost; module: WasmModule }>();

// Sketches
const sketches = new Map<string, Sketch>();

// Trace points
let tracePoints: TracePoint[] = [];

// Per-module render targets (one per real module instance)
const moduleRenderTargets = new Map<string, { tex: GPUTexture; handle: number }>();

// Per-sketch output texture handles (from current frame)
const sketchOutputs = new Map<string, number>();

// Render loop state
let running = false;
let frameInFlight = false;
let lastTime = 0;
let elapsed = 0;
let frameCount = 0;
let fpsTime = 0;
let fps = 0;
let stateGeneration = 0;
let lastBroadcastGeneration = -1;

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
      await init(cmd.width, cmd.height);
      break;
    case 'resize':
      if (canvas) { canvas.width = cmd.width; canvas.height = cmd.height; }
      break;
    case 'loadModule':
      await loadModule(cmd.moduleType);
      break;
    case 'createSketch':
      sketches.set(cmd.sketchId, cmd.sketch);
      markDirty();
      break;
    case 'updateSketch':
      sketches.set(cmd.sketchId, cmd.sketch);
      markDirty();
      break;
    case 'setParam': {
      const sketch = sketches.get(cmd.sketchId);
      if (sketch) {
        const entry = sketch.columns[cmd.colIdx]?.chain[cmd.chainIdx];
        if (entry?.type === 'module') {
          entry.params[String(cmd.paramIndex)] = cmd.value;
          // Update live instance immediately
          if (sketchExecutor) {
            const loaded = sketchExecutor.getInstance(entry.instance_key);
            if (loaded) {
              loaded.host.frameState.params[cmd.paramIndex] = cmd.value;
              loaded.module.onParamChange(cmd.paramIndex, cmd.value);
              // Find field name from params keys
              const fieldName = Object.keys(entry.params).find(
                (_, idx) => idx === cmd.paramIndex) ?? String(cmd.paramIndex);
              loaded.host.notifyStatePatched(loaded.module, [
                { op: 'replace', path: fieldName, value: cmd.value },
              ]);
            }
          }
        }
      }
      break;
    }
    case 'setTracePoints':
      tracePoints = cmd.tracePoints;
      console.log('[worker] setTracePoints:', JSON.stringify(cmd.tracePoints.map(tp => ({ id: tp.id, target: tp.target }))));
      console.log('[worker] current realOutputs:', Object.fromEntries(realModules.keys() ? [...realModules.keys()].map(k => [k, moduleRenderTargets.get(k)?.handle ?? 'none']) : []));
      console.log('[worker] current sketchOutputs:', Object.fromEntries(sketchOutputs));
      console.log('[worker] current sketches:', [...sketches.entries()].map(([id, s]) => `${id} anchor=${s.anchor}`).join(', '));
      break;
  }
}

async function init(width: number, height: number) {
  canvas = new OffscreenCanvas(width, height);

  bridgeCore = new BridgeCore();
  await bridgeCore.init();

  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    post({ type: 'error', message: 'No GPU adapter available' });
    return;
  }
  gpuDevice = await adapter.requestDevice();
  const format = 'rgba8unorm';

  gpuContext = canvas.getContext('webgpu') as GPUCanvasContext;
  gpuContext.configure({ device: gpuDevice, format, alphaMode: 'premultiplied' });

  gpuHost = new GPUHost(gpuDevice, format);
  sketchExecutor = new SketchExecutor(bridgeCore, gpuHost, gpuDevice, format);
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

  const now = performance.now() / 1000;
  const dt = now - lastTime;
  lastTime = now;
  elapsed += dt;

  frameCount++;
  fpsTime += dt;
  if (fpsTime >= 1.0) {
    fps = frameCount;
    frameCount = 0;
    fpsTime = 0;
  }

  if (bridgeCore) bridgeCore.tick();

  await simulateTick(dt);
  captureAndSendFrame();

  if (stateGeneration !== lastBroadcastGeneration) {
    broadcastState();
    lastBroadcastGeneration = stateGeneration;
  }

  frameInFlight = false;
  requestAnimationFrame(frame);
}

/**
 * Simulate one frame of the entire composition.
 */
async function simulateTick(dt: number) {
  if (!gpuHost || !gpuContext || !canvas || !sketchExecutor) return;
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;

  const frameState = {
    elapsedTime: elapsed,
    deltaTime: dt,
    barPhase: (elapsed * 120 / 60 / 4) % 1.0,
    bpm: 120,
    viewportW: w,
    viewportH: h,
    params: new Array(16).fill(0),
  };

  // 1. Tick all real modules
  for (const [_key, { host, module: mod }] of realModules) {
    host.frameState.elapsedTime = frameState.elapsedTime;
    host.frameState.deltaTime = frameState.deltaTime;
    host.frameState.barPhase = frameState.barPhase;
    host.frameState.bpm = frameState.bpm;
    host.frameState.viewportW = w;
    host.frameState.viewportH = h;
    mod.tick(dt);
  }

  // 2. Render each real module to its own texture
  const realOutputs = new Map<string, number>();
  for (const [key, { host, module: mod }] of realModules) {
    // Get or create a per-module render target
    let rt = moduleRenderTargets.get(key);
    if (!rt || rt.tex.width !== w || rt.tex.height !== h) {
      rt?.tex.destroy();
      const tex = gpuDevice!.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const handle = gpuHost.injectTexture(tex);
      rt = { tex, handle };
      moduleRenderTargets.set(key, rt);
    }
    gpuHost.setSurface(rt.tex, w, h);
    host.drawList = [];
    mod.render(w, h);
    // Store the per-module render target handle (NOT the surface handle,
    // which gets overwritten by subsequent setSurface calls).
    realOutputs.set(key, rt.handle);
  }

  // 3. Execute sketch chains
  sketchOutputs.clear();
  for (const [sketchId, sketch] of sketches) {
    let inputHandle = -1;
    if (sketch.anchor && realOutputs.has(sketch.anchor)) {
      inputHandle = realOutputs.get(sketch.anchor)!;
    } else if (sketch.anchor) {
      console.warn(`[worker] sketch ${sketchId} anchor '${sketch.anchor}' not found in realOutputs. Keys:`, [...realOutputs.keys()]);
    }

    try {
      const outputHandle = await sketchExecutor.executeSketch(
        sketchId, sketch, 0, inputHandle, frameState, w, h);
      if (frameCount < 3) console.log(`[worker] sketch ${sketchId}: anchor=${sketch.anchor} inputHandle=${inputHandle} → outputHandle=${outputHandle}`);
      sketchOutputs.set(sketchId, outputHandle);
    } catch (err) {
      console.error(`[sketch ${sketchId}]`, err);
    }
  }

  // 4. Resolve trace point handles
  for (const tp of tracePoints) {
    let handle = -1;
    if (tp.target.type === 'sketch_output') {
      handle = sketchOutputs.get(tp.target.sketchId) ?? -1;
    } else if (tp.target.type === 'plugin_output') {
      handle = realOutputs.get(tp.target.pluginKey) ?? -1;
    }
    const prevHandle = traceHandles.get(tp.id);
    if (prevHandle !== handle) {
      console.log(`[worker] trace '${tp.id}' handle changed: ${prevHandle} → ${handle} (target: ${JSON.stringify(tp.target)})`);
    }
    traceHandles.set(tp.id, handle);
  }
}

/** Resolved texture handles for each trace point (populated by simulateTick). */
const traceHandles = new Map<string, number>();

/**
 * Capture each trace point by blitting its texture to an OffscreenCanvas
 * and calling transferToImageBitmap(). Fully GPU-resident — no CPU readback.
 */
function captureAndSendFrame() {
  if (!gpuHost || !traceCapture) return;

  const tracedFrames: Record<string, ImageBitmap> = {};
  const transfers: Transferable[] = [];

  if (tracePoints.length === 0 || traceHandles.size === 0) {
    post({ type: 'frame', fps, tracedFrames }, []);
    return;
  }

  for (const tp of tracePoints) {
    const handle = traceHandles.get(tp.id) ?? -1;
    if (handle < 0) continue;

    const srcTex = gpuHost.getTextureByHandle(handle);
    if (!srcTex) continue;

    try {
      const bitmap = traceCapture.capture(tp.id, srcTex);
      tracedFrames[tp.id] = bitmap;
      transfers.push(bitmap);
    } catch (e) {
      console.warn(`[trace ${tp.id}] capture failed:`, e);
    }
  }

  post({ type: 'frame', fps, tracedFrames }, transfers);
}

// ========================================================================
// Module loading
// ========================================================================

async function loadModule(moduleType: string) {
  if (!bridgeCore || !gpuHost) return;

  // Derive WASM filename from module type.
  // Strip "com.nattos." prefix, replace remaining dots with underscores.
  const moduleName = moduleType.replace(/^com\.nattos\./, '').replace(/\./g, '_');
  const host = new WasmHost();
  host.bridgeCore = bridgeCore;
  host.gpuHost = gpuHost;

  try {
    const mod = await host.load(`/wasm/${moduleName}.wasm`);
    mod.init();
    const key = host.pluginKey || `${moduleType}@0`;
    realModules.set(key, { host, module: mod });
    markDirty();
  } catch (e) {
    post({ type: 'error', message: `Failed to load ${moduleType}: ${e}` });
  }
}

// ========================================================================
// State broadcast
// ========================================================================

function broadcastState() {
  if (!bridgeCore) return;

  const globalData = bridgeCore.getAt('/global');
  const plugins: PluginInfo[] = [];

  if (globalData?.plugins) {
    for (const entry of globalData.plugins) {
      plugins.push({
        key: entry.key,
        id: entry.metadata?.id ?? '',
        version: entry.metadata?.version
          ? `${entry.metadata.version.major}.${entry.metadata.version.minor}.${entry.metadata.version.patch}`
          : '0.0.0',
        params: (entry.params ?? []).map((p: any) => ({
          index: p.index,
          name: p.name,
          type: p.type,
          defaultValue: p.default ?? p.defaultValue ?? 0,
          min: p.min ?? 0,
          max: p.max ?? 1,
        })),
        io: entry.io ?? [],
      });
    }
  }

  const sketchRecord: Record<string, Sketch> = {};
  for (const [id, sketch] of sketches) {
    sketchRecord[id] = sketch;
  }

  post({ type: 'state', state: { plugins, sketches: sketchRecord } });
}

// ========================================================================
// Message handler (queued)
// ========================================================================

ctx.onmessage = (e: MessageEvent<WorkerCommand>) => {
  pendingCommands.push(e.data);
  processQueue();
};
