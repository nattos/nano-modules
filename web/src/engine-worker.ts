/**
 * Engine worker — runs bridge core, WASM modules, and GPU rendering
 * off the main thread.
 *
 * simulateTick() runs the full composition each frame:
 * 1. Tick all real plugin instances
 * 2. Execute sketch chains (virtual instances with texture routing)
 * 3. Capture trace point outputs as ImageBitmaps
 */

import { BridgeCore } from './bridge-core';
import { GPUHost } from './gpu-host';
import { WasmHost, WasmModule } from './wasm-host';
import { SketchExecutor } from './sketch-executor';
import type { WorkerCommand, WorkerEvent, EngineState, PluginInfo, TracePoint } from './engine-types';
import type { Sketch } from './sketch-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let bridgeCore: BridgeCore | null = null;
let gpuHost: GPUHost | null = null;
let gpuDevice: GPUDevice | null = null;
let canvas: OffscreenCanvas | null = null;
let gpuContext: GPUCanvasContext | null = null;
let sketchExecutor: SketchExecutor | null = null;

// Real module instances (loaded via loadModule command)
const realModules = new Map<string, { host: WasmHost; module: WasmModule }>();

// Sketches (managed locally in worker)
const sketches = new Map<string, Sketch>();

// Trace points (set by main thread)
let tracePoints: TracePoint[] = [];

// Per-sketch output texture handles (from last frame's execution)
const sketchOutputs = new Map<string, number>();

// Render loop state
let running = false;
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
      // Update the sketch data
      const sketch = sketches.get(cmd.sketchId);
      if (sketch) {
        const entry = sketch.columns[cmd.colIdx]?.chain[cmd.chainIdx];
        if (entry?.type === 'module') {
          entry.params[String(cmd.paramIndex)] = cmd.value;
        }
      }
      // Also update the live virtual instance immediately
      if (sketchExecutor) {
        // Find the instance key from the sketch
        const sk = sketches.get(cmd.sketchId);
        const entry = sk?.columns[cmd.colIdx]?.chain[cmd.chainIdx];
        if (entry?.type === 'module') {
          const loaded = sketchExecutor.getInstance(entry.instance_key);
          if (loaded) {
            loaded.host.frameState.params[cmd.paramIndex] = cmd.value;
            loaded.module.onParamChange(cmd.paramIndex, cmd.value);
          }
        }
      }
      break;
    }
    case 'setTracePoints':
      tracePoints = cmd.tracePoints;
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

  post({ type: 'ready' });
  markDirty();

  running = true;
  lastTime = performance.now() / 1000;
  requestAnimationFrame(frame);
}

// ========================================================================
// Frame loop
// ========================================================================

function frame() {
  if (!running) return;

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

  simulateTick(dt);

  // Capture trace points and send frame
  captureAndSendFrame();

  // Broadcast state if dirty
  if (stateGeneration !== lastBroadcastGeneration) {
    broadcastState();
    lastBroadcastGeneration = stateGeneration;
  }

  requestAnimationFrame(frame);
}

/**
 * Simulate one frame of the entire composition:
 * 1. Tick all real modules
 * 2. Render real modules to the composition surface
 * 3. Execute sketch chains (virtual modules with texture routing)
 */
function simulateTick(dt: number) {
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

  // 2. Render real modules to the main surface
  const surfaceTex = gpuContext.getCurrentTexture();
  gpuHost.setSurface(surfaceTex, w, h);

  // Render first real module to the main surface (composition output)
  let mainOutputHandle = -1;
  for (const [key, { host, module: mod }] of realModules) {
    host.drawList = [];
    mod.render(w, h);
    mainOutputHandle = gpuHost.getSurfaceTexture();
    break; // just the first for now
  }

  // 3. Execute sketch chains
  for (const [sketchId, sketch] of sketches) {
    // The sketch's anchor module provides the input texture
    let inputHandle = -1;
    if (sketch.anchor) {
      const anchorModule = realModules.get(sketch.anchor);
      if (anchorModule) {
        // The anchor module already rendered to the main surface
        // Use the surface texture as the input
        inputHandle = mainOutputHandle;
      }
    }

    // Execute the chain (async, but we fire-and-forget for now)
    sketchExecutor.executeSketch(sketch, 0, inputHandle, frameState, w, h)
      .then(outputHandle => {
        sketchOutputs.set(sketchId, outputHandle);
      })
      .catch(err => {
        console.error(`[sketch ${sketchId}]`, err);
      });
  }
}

/**
 * Capture trace point outputs and send as ImageBitmaps.
 */
function captureAndSendFrame() {
  if (!canvas || !gpuHost) return;

  const tracedFrames: Record<string, ImageBitmap> = {};
  const transfers: Transferable[] = [];

  // For each trace point, get the appropriate texture and create a bitmap
  for (const tp of tracePoints) {
    if (tp.target.type === 'sketch_output') {
      const outputHandle = sketchOutputs.get(tp.target.sketchId);
      if (outputHandle !== undefined && outputHandle >= 0) {
        // Read back the sketch output texture to a bitmap
        // For now, we render the sketch output to the main canvas and capture that
        // TODO: direct texture readback without going through the main canvas
      }
    }
  }

  // Always send the main canvas as a bitmap (the composition output)
  if (canvas.width > 0 && canvas.height > 0) {
    const bitmap = canvas.transferToImageBitmap();
    // If there's an 'edit_preview' trace point, use the main canvas for now
    for (const tp of tracePoints) {
      if (tp.id === 'edit_preview') {
        tracedFrames[tp.id] = bitmap;
        transfers.push(bitmap);
      }
    }
    // If no trace point claimed the bitmap, still send it for the default view
    if (transfers.length === 0) {
      tracedFrames['_main'] = bitmap;
      transfers.push(bitmap);
    }
  }

  post({ type: 'frame', fps, tracedFrames }, transfers);
}

// ========================================================================
// Module loading
// ========================================================================

async function loadModule(moduleType: string) {
  if (!bridgeCore || !gpuHost) return;

  const moduleName = moduleType.split('.').pop() ?? moduleType;
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

function paramMinMax(type: number): { min: number; max: number } {
  switch (type) {
    case 0: return { min: 0, max: 1 };   // boolean
    case 1: return { min: 0, max: 1 };   // event
    case 10: return { min: 0, max: 1 };  // standard float
    case 11: return { min: 0, max: 1 };  // option
    case 13: return { min: 0, max: 100 }; // integer (default range)
    default: return { min: 0, max: 1 };
  }
}

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
          ...paramMinMax(p.type),
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
