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
import { WasmHost, WasmModule, type EffectInfo } from './wasm-host';
import { SketchExecutor } from './sketch-executor';
import { TraceCapture } from './trace-capture';
import type { WorkerCommand, WorkerEvent, EngineState, PluginInfo, TracePoint } from './engine-types';
import { BUCKET_SKETCH_ID, type Sketch } from './sketch-types';

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

// Registry of compiled WASM modules and their available effects
interface LoadedWasmModule {
  moduleId: string;    // e.g. "com.nattos.nano_effects"
  compiled: WebAssembly.Module;
  effects: EffectInfo[];
}
const moduleRegistry = new Map<string, LoadedWasmModule>();

// Flattened effect registry: module-relative ID → { compiled, effect }
// "Last wins" — later registrations override earlier ones.
const effectRegistry = new Map<string, { compiled: WebAssembly.Module; effect: EffectInfo }>();

/** Resolve an effect ID that may be module-qualified or module-relative. */
function resolveEffectId(id: string): string {
  // If it's already in the registry as-is, it's module-relative
  if (effectRegistry.has(id)) return id;
  // Try stripping known module prefixes (e.g. "com.nattos.nano_effects.video.blend" → "video.blend")
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
    case 'instantiateEffect':
      await instantiateEffect(cmd.effectId);
      break;
    case 'createSketch':
      sketches.set(cmd.sketchId, cmd.sketch);
      removeInstancesFromBucket(cmd.sketch);
      markDirty();
      break;
    case 'updateSketch':
      sketches.set(cmd.sketchId, cmd.sketch);
      removeInstancesFromBucket(cmd.sketch);
      markDirty();
      break;
    case 'setParam': {
      const sketch = sketches.get(cmd.sketchId);
      if (sketch) {
        const entry = sketch.columns[cmd.colIdx]?.chain[cmd.chainIdx];
        if (entry?.type === 'module') {
          // Update the instance state in the sketch (if instances map exists)
          if (sketch.instances?.[entry.instance_key]) {
            sketch.instances[entry.instance_key].state[cmd.paramKey] = cmd.value;
          }
          // Update live instance immediately via pluginState
          if (sketchExecutor) {
            const loaded = sketchExecutor.getInstance(entry.instance_key);
            if (loaded) {
              loaded.host.notifyStatePatched(loaded.module, [
                { op: 'replace', path: cmd.paramKey, value: cmd.value },
              ]);
            }
          }
        }
      }
      break;
    }
    case 'setTracePoints':
      tracePoints = cmd.tracePoints;
      break;
    case 'debugDump': {
      const bridgeState = bridgeCore ? bridgeCore.getAt('/') : null;
      const sketchRecord: Record<string, any> = {};
      for (const [id, sketch] of sketches) sketchRecord[id] = sketch;

      const instanceInfo: Record<string, any> = {};
      if (sketchExecutor) {
        for (const [id, sketch] of sketches) {
          for (const col of sketch.columns) {
            for (const entry of col.chain) {
              if (entry.type === 'module') {
                const loaded = sketchExecutor.getInstance(entry.instance_key);
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
      }

      post({ type: 'debugDump', data: { bridgeState, sketches: sketchRecord, instances: instanceInfo } });
      break;
    }
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
  sketchExecutor = new SketchExecutor(bridgeCore, gpuHost, gpuDevice, format, findCompiledModule);
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

  // Clear per-frame chain entry handles before executing sketches
  sketchExecutor.chainEntryHandles.clear();

  // NOTE: A real module instance appearing in multiple sketches will only be
  // ticked/rendered once (by whichever sketch chain processes it first). The
  // second sketch will see stale output. Resolume handles this by cloning the
  // instance per-composition — we'll need to do the same eventually.

  // 1. Collect instance keys used by sketch chains so we don't double-render them
  const sketchInstanceKeys = new Set<string>();
  for (const [, sketch] of sketches) {
    for (const col of sketch.columns) {
      for (const entry of col.chain) {
        if (entry.type === 'module') {
          sketchInstanceKeys.add(entry.instance_key);
        }
      }
    }
  }

  // 2. Register real modules into the sketch executor so it reuses them
  for (const [key, { host, module: mod }] of realModules) {
    if (sketchInstanceKeys.has(key)) {
      sketchExecutor.registerInstance(key, host, mod);
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
  sketchOutputs.clear();
  for (const [sketchId, sketch] of sketches) {
    let inputHandle = -1;
    if (sketch.anchor && realOutputs.has(sketch.anchor)) {
      inputHandle = realOutputs.get(sketch.anchor)!;
    }

    try {
      const outputHandle = await sketchExecutor.executeAllColumns(
        sketchId, sketch, inputHandle, frameState, w, h);
      // (debug) if (frameCount < 3) console.log(`[worker] sketch ${sketchId}: anchor=${sketch.anchor} outputHandle=${outputHandle}`);
      sketchOutputs.set(sketchId, outputHandle);
    } catch (err) {
      console.error(`[sketch ${sketchId}]`, err);
    }
  }

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

  // 5. Resolve trace point handles
  for (const tp of tracePoints) {
    let handle = -1;
    if (tp.target.type === 'sketch_output') {
      handle = sketchOutputs.get(tp.target.sketchId) ?? -1;
    } else if (tp.target.type === 'plugin_output') {
      handle = realOutputs.get(tp.target.pluginKey) ?? -1;
    } else if (tp.target.type === 'chain_entry') {
      const key = `${tp.target.sketchId}/${tp.target.colIdx}/${tp.target.chainIdx}`;
      const entry = sketchExecutor.chainEntryHandles.get(key);
      if (entry) {
        handle = tp.target.side === 'input' ? entry.input : entry.output;
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const handle = gpuHost!.injectTexture(tex);
    rt = { tex, handle };
    moduleRenderTargets.set(key, rt);
  }
  return rt;
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

  const sketchState = bridgeCore?.getAt('/sketch_state') ?? {};

  // Collect live pluginState for all instances (sketch executor + real modules)
  const pluginStates: Record<string, any> = sketchExecutor
    ? sketchExecutor.getPluginStates()
    : {};
  for (const [key, { host }] of realModules) {
    if (!(key in pluginStates) && host.pluginState && Object.keys(host.pluginState).length > 0) {
      pluginStates[key] = host.pluginState;
    }
  }

  if (tracePoints.length === 0 || traceHandles.size === 0) {
    post({ type: 'frame', fps, tracedFrames, sketchState, pluginStates }, []);
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

  post({ type: 'frame', fps, tracedFrames, sketchState, pluginStates }, transfers);
}

// ========================================================================
// Module loading
// ========================================================================

/** Find the compiled WebAssembly.Module that contains a given effect ID (module-relative or qualified). */
function findCompiledModule(effectId: string): WebAssembly.Module | null {
  const resolved = resolveEffectId(effectId);
  const entry = effectRegistry.get(resolved);
  return entry?.compiled ?? null;
}

/**
 * Load a WASM module and discover its available effects.
 * Does NOT instantiate any effects — call instantiateEffect() separately.
 */
async function loadModule(moduleType: string) {
  if (!bridgeCore || !gpuHost) return;

  // Derive WASM filename from module type.
  const moduleName = moduleType.replace(/^com\.nattos\./, '').replace(/\./g, '_');
  const wasmUrl = `/wasm/${moduleName}.wasm`;

  // Don't reload if already registered
  if (moduleRegistry.has(wasmUrl)) {
    const existing = moduleRegistry.get(wasmUrl)!;
    post({ type: 'effectsDiscovered', effects: existing.effects.map(e => ({
      id: e.id, name: e.name, description: e.description,
      category: e.category, keywords: e.keywords,
    })) });
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
    post({ type: 'effectsDiscovered', effects: effects.map(e => ({
      id: e.id, name: e.name, description: e.description,
      category: e.category, keywords: e.keywords,
    })) });

    markDirty();
  } catch (e) {
    post({ type: 'error', message: `Failed to load ${moduleType}: ${e}` });
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
  const compiled = findCompiledModule(resolvedId);
  if (!compiled) {
    post({ type: 'error', message: `Effect "${effectId}" not found in any loaded module` });
    return;
  }

  const host = new WasmHost();
  host.bridgeCore = bridgeCore;
  host.gpuHost = gpuHost;

  try {
    await host.load(compiled);
    const mod = host.activateEffect(resolvedId);

    const key = host.pluginKey || `${resolvedId}@0`;
    realModules.set(key, { host, module: mod });

    // Ensure the unassigned bucket sketch exists
    if (!sketches.has(BUCKET_SKETCH_ID)) {
      sketches.set(BUCKET_SKETCH_ID, {
        anchor: null,
        columns: [],
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
  for (const col of sketch.columns) {
    for (const entry of col.chain) {
      if (entry.type === 'module') {
        delete bucket.instances[entry.instance_key];
      }
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

  const globalData = bridgeCore.getAt('/global');
  const plugins: PluginInfo[] = [];

  if (globalData?.plugins) {
    for (const entry of globalData.plugins) {
      // BridgeCore's native parser may not emit data_output io entries for
      // float fields with the Output flag. Merge ioDecls from the WasmHost
      // which correctly parses the schema on the JS side.
      let io: any[] = entry.io ?? [];
      const real = realModules.get(entry.key);
      if (real) {
        const hostDecls = real.host.ioDecls;
        // Add any host-side io declarations not already present
        for (const decl of hostDecls) {
          if (!io.some((e: any) => e.name === decl.name && e.kind === decl.kind)) {
            io.push(decl);
          }
        }
      }

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
        io,
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
