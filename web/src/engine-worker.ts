/**
 * Engine worker — runs bridge core, WASM modules, and GPU rendering
 * off the main thread.
 *
 * Renders to its own OffscreenCanvas and posts ImageBitmap frames
 * back to the main thread for display.
 */

import { BridgeCore } from './bridge-core';
import { GPUHost } from './gpu-host';
import { WasmHost, WasmModule } from './wasm-host';
import type { WorkerCommand, WorkerEvent, EngineState, PluginInfo } from './engine-types';
import type { Sketch } from './sketch-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let bridgeCore: BridgeCore | null = null;
let gpuHost: GPUHost | null = null;
let gpuDevice: GPUDevice | null = null;
let canvas: OffscreenCanvas | null = null;
let gpuContext: GPUCanvasContext | null = null;

// Loaded modules
const loadedModules = new Map<string, { host: WasmHost; module: WasmModule }>();

// Sketches (managed locally in worker for now)
const sketches = new Map<string, Sketch>();

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

function markDirty() {
  stateGeneration++;
}

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
      if (canvas) {
        canvas.width = cmd.width;
        canvas.height = cmd.height;
      }
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
    case 'setParam':
      break;
  }
}

async function init(width: number, height: number) {
  // Create our own OffscreenCanvas (not transferred from main thread)
  canvas = new OffscreenCanvas(width, height);

  // Init bridge core
  bridgeCore = new BridgeCore();
  await bridgeCore.init();

  // Init WebGPU
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

  post({ type: 'ready' });
  markDirty();

  // Start render loop
  running = true;
  lastTime = performance.now() / 1000;
  requestAnimationFrame(frame);
}

function frame() {
  if (!running) return;

  const now = performance.now() / 1000;
  const dt = now - lastTime;
  lastTime = now;
  elapsed += dt;

  frameCount++;
  fpsTime += dt;

  // Tick bridge core
  if (bridgeCore) bridgeCore.tick();

  // Tick all loaded modules
  for (const [_key, { host, module: mod }] of loadedModules) {
    host.frameState.elapsedTime = elapsed;
    host.frameState.deltaTime = dt;
    host.frameState.barPhase = (elapsed * 120 / 60 / 4) % 1.0;
    host.frameState.bpm = 120;
    host.frameState.viewportW = canvas?.width ?? 0;
    host.frameState.viewportH = canvas?.height ?? 0;
    mod.tick(dt);
  }

  // Render to offscreen canvas
  if (gpuContext && gpuHost && canvas && canvas.width > 0 && canvas.height > 0) {
    const surfaceTex = gpuContext.getCurrentTexture();
    gpuHost.setSurface(surfaceTex, canvas.width, canvas.height);

    for (const [_key, { host, module: mod }] of loadedModules) {
      host.drawList = [];
      mod.render(canvas.width, canvas.height);
      break;
    }
  }

  // Send frame bitmap + FPS at ~1Hz
  if (fpsTime >= 1.0) {
    fps = frameCount;
    frameCount = 0;
    fpsTime = 0;
  }

  // Post bitmap every frame
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    const bitmap = canvas.transferToImageBitmap();
    post({ type: 'frame', fps, bitmap }, [bitmap]);
  }

  // Broadcast state if dirty
  if (stateGeneration !== lastBroadcastGeneration) {
    broadcastState();
    lastBroadcastGeneration = stateGeneration;
  }

  requestAnimationFrame(frame);
}

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
    loadedModules.set(key, { host, module: mod });
    markDirty();
  } catch (e) {
    post({ type: 'error', message: `Failed to load ${moduleType}: ${e}` });
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

// --- Message handler (queued) ---

ctx.onmessage = (e: MessageEvent<WorkerCommand>) => {
  pendingCommands.push(e.data);
  processQueue();
};
