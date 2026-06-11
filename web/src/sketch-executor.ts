/**
 * Sketch executor — walks chains of virtual module instances,
 * piping textures and data between modules via sideband rails.
 */

import type { BridgeCore } from './bridge-core';
import type { GPUHost } from './gpu-host';
import { WasmHost, WasmModule, FrameState } from './wasm-host';
import type { ChainEntry, ModuleEntry, Sketch, SketchColumn, Rail, Tap } from './sketch-types';
import { applyTapMod, combineTap } from './tap-mod';
import { initSmooth, advanceSmooth, type SmoothState } from './param-smoothing';
import {
  FusionDispatcher,
  FUSION_KIND_FREEFORM,
  FUSION_KIND_PER_PIXEL_MAPPER,
  FUSION_KIND_STRICT_OUTPUT,
  type FusionStage,
} from './fusion-dispatcher';

/**
 * Engine-wide fusion mode, settable by tests via the worker's
 * `setFusionMode` command.
 *
 *   - 'auto'      — production default; the planner fuses any run of
 *                   two-or-more eligible mappers (single-stage runs
 *                   stay on the standalone path so non-fused effects
 *                   are unaffected).
 *   - 'force-on'  — every fusion-eligible stage is routed through the
 *                   dispatcher, including length-1 runs. Used by the
 *                   per-effect parametric tests to verify byte-identity
 *                   between the standalone and fused paths.
 *   - 'force-off' — disables fusion entirely; every stage takes the
 *                   standalone path. Lets tests pin behavior to the
 *                   pre-fusion baseline regardless of effect class.
 */
export type FusionMode = 'auto' | 'force-on' | 'force-off';

interface LoadedModule {
  host: WasmHost;
  module: WasmModule;
  /**
   * Device on/off state from the previous frame (true = on). Persisted on the
   * cached instance so the executor fires `onActive` only on a transition.
   * Undefined until the first frame (treated as on).
   */
  active?: boolean;
  /**
   * Per-field parameter-smoothing timer state, keyed by fieldPath. Persisted on
   * the cached instance so the linear ramp survives across frames; reset for
   * free when the instance is dropped/recreated on a module-type change.
   */
  smoothing?: Map<string, SmoothState>;
}

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

/**
 * Map a sketch instance's persisted `state` into the patches replayed into a
 * freshly-loaded effect (its on_state_patched), plus the dense positional float
 * row for legacy host::param(index) reads.
 *
 * Every JSON value type that can live in instance state must have a branch here
 * or it is silently dropped on restore — which is exactly how text params used
 * to be "forgotten" across reloads: number/boolean/numeric-array were handled
 * but `string` was not, so gen.text's `text` and gen.richtext's `html`/`css`
 * never reached the effect and it fell back to the schema default. Strings and
 * numeric arrays are patch-only (no positional float slot); number/boolean also
 * contribute a positional float, in encounter order.
 *
 * Exported for unit testing — this is the locus of the dropped-param class of
 * bug, so it is covered directly.
 */
export function instanceStateToParams(
  instanceState: Record<string, unknown>,
): { patches: import('./wasm-host').PatchOp[]; positional: number[] } {
  const patches: import('./wasm-host').PatchOp[] = [];
  const positional: number[] = [];
  for (const [key, value] of Object.entries(instanceState)) {
    // Reserved engine keys (e.g. __bypass__, __opacity__) are handled by the
    // executor itself — never delivered to the effect as params.
    if (key.startsWith('__')) continue;
    if (typeof value === 'number') {
      positional.push(value);
      patches.push({ op: 'replace', path: key, value });
    } else if (typeof value === 'boolean') {
      // Booleans ride the positional row as 0/1 but stay typed in the patch —
      // the effect reads either via patchFloat (0.0/1.0) or val::asBool.
      positional.push(value ? 1 : 0);
      patches.push({ op: 'replace', path: key, value });
    } else if (Array.isArray(value) && value.every(v => typeof v === 'number')) {
      // Vec2/3/4 (and other plain numeric arrays): patch only, no float slot.
      patches.push({ op: 'replace', path: key, value });
    } else if (typeof value === 'string') {
      // String params (gen.text `text`, gen.richtext `html`/`css`) are
      // patch-only; the downstream bridge-core commit already handles strings.
      patches.push({ op: 'replace', path: key, value });
    }
    // Anything else (objects, mixed arrays) is left for the effect to handle.
  }
  return { patches, positional };
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

/** Runtime value on a rail during a single frame's execution. */
interface RailValue {
  data?: number;
  texture?: number;  // GPU texture handle
  /**
   * Structural payload for struct rails. Captured from the writer's
   * state subtree at write-tap time. Leaves that are textures or GPU
   * arrays carry integer handles, not resource objects, exactly like
   * scalar texture rails do today.
   */
  struct?: any;
  /**
   * True when the writer announced a dirty GPU subtree (markGpuDirty /
   * setGpuBuffer) during this frame. The read tap forwards this as a
   * "dirty" patch to the downstream module instead of a "replace".
   */
  dirty?: boolean;
}

export class SketchExecutor {
  private bridgeCore: BridgeCore;
  private gpuHost: GPUHost;
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private findModule: (effectId: string) => { compiled: WebAssembly.Module; resolvedId: string } | null;

  private instances = new Map<string, LoadedModule>();
  private sketchIntermediates = new Map<string, { textures: GPUTexture[]; handles: number[] }>();

  /// Owns the WGSL composition + pipeline cache for fused runs.
  private fusionDispatcher: FusionDispatcher;
  private fusionMode: FusionMode = 'auto';

  setFusionMode(mode: FusionMode): void {
    this.fusionMode = mode;
  }
  getFusionMode(): FusionMode {
    return this.fusionMode;
  }

  /**
   * Per-frame debug counters. Always collected (cost is a handful of
   * integer increments); only broadcast to the main thread when the
   * worker is in debug mode. Worker reads + resets via
   * `consumeDebugStats()` once per frame.
   */
  private debugStats = {
    effectsExecuted: 0,
    standaloneDispatches: 0,
    fusedRuns: 0,
    fusedStages: 0,
    identitySkipped: 0,
  };

  consumeDebugStats(): import('./engine-types').DebugStats {
    const s = this.debugStats;
    const out = {
      effectsExecuted: s.effectsExecuted,
      standaloneDispatches: s.standaloneDispatches,
      fusedRuns: s.fusedRuns,
      fusedStages: s.fusedStages,
      dispatchesSaved: Math.max(0, s.fusedStages - s.fusedRuns),
      gpuDispatches: s.standaloneDispatches + s.fusedRuns,
      identitySkipped: s.identitySkipped,
    };
    this.debugStats.effectsExecuted = 0;
    this.debugStats.standaloneDispatches = 0;
    this.debugStats.fusedRuns = 0;
    this.debugStats.fusedStages = 0;
    this.debugStats.identitySkipped = 0;
    return out;
  }

  /**
   * Per-chain-entry texture handles from the most recent frame.
   * Keyed by `${sketchId}/${colIdx}/${chainIdx}`.
   * Populated during executeColumn(), consumed by engine-worker for chain_entry trace points.
   */
  public chainEntryHandles = new Map<string, { input: number; output: number }>();

  /**
   * Set of `${sketchId}/${colIdx}/${chainIdx}` keys that currently
   * have an active trace point. Set per-frame by the engine worker
   * (derived from its `tracePoints` list). The fusion planner reads
   * this when flushing a fused run to decide which intermediate
   * stages need their post-pixel value written out to a real
   * texture (the dispatcher composes a "traced" shader variant when
   * any non-final stage in the run is traced).
   */
  public tracedChainEntries: Set<string> = new Set();

  /** Collect pluginState snapshots for all loaded instances. */
  getPluginStates(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, { host }] of this.instances) {
      if (host.pluginState && Object.keys(host.pluginState).length > 0) {
        result[key] = host.pluginState;
      }
    }
    return result;
  }

  /**
   * Drain console-log entries emitted this frame from every loaded
   * instance. Each WasmHost keeps its own rolling buffer; this
   * captures and clears all of them so the worker can ship a single
   * aggregated batch with the frame event.
   */
  drainConsoleLogs(): import('./engine-types').DebugConsoleEntry[] {
    const out: import('./engine-types').DebugConsoleEntry[] = [];
    for (const [instanceKey, { host }] of this.instances) {
      if (host.consoleLogs.length === 0) continue;
      const moduleId = host.metadata?.id ?? instanceKey;
      for (const entry of host.consoleLogs) {
        out.push({
          instanceKey,
          moduleId,
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          data: entry.data,
        });
      }
      host.consoleLogs = [];
    }
    return out;
  }

  /// Optional: invoked when an instance's schema visibility (or
  /// equivalent state-affecting overlay) changes, so the engine
  /// worker can mark its broadcast generation dirty.
  onHostSchemaChanged?: () => void;

  constructor(
    bridgeCore: BridgeCore, gpuHost: GPUHost, device: GPUDevice, format: GPUTextureFormat,
    findModule: (effectId: string) => { compiled: WebAssembly.Module; resolvedId: string } | null,
  ) {
    this.bridgeCore = bridgeCore;
    this.gpuHost = gpuHost;
    this.device = device;
    this.format = format;
    this.findModule = findModule;
    this.fusionDispatcher = new FusionDispatcher(gpuHost);
  }

  /** Drop cached fused pipelines that include `effectId`. Called from
   *  the engine worker on HMR reload so the recompiled effect's new
   *  fragment is picked up on the next dispatch. */
  invalidateFusionCacheFor(effectId: string): void {
    this.fusionDispatcher.invalidate(effectId);
  }

  /**
   * Decide whether `entry` can take the fused path. A stage is fusable
   * when (a) the engine is in a mode that allows fusion, (b) the
   * effect declared a non-Freeform fusion class, (c) it published a
   * fragment to compose against, (d) a uniform buffer to bind, and
   * (e) the entry has no taps.
   *
   * Taps disqualify a stage because:
   *   - read taps with texture rails introduce a second input texture
   *     binding, which the composer doesn't expose.
   *   - write taps that publish the stage's `tex_out` to a rail want
   *     a real intermediate texture; in a fused run the intermediate
   *     output of any non-final stage exists only in registers.
   * (Both restrictions are loosened in later phases — write taps
   * could route to trace textures; multi-input mapper stages would
   * force a run split in the planner.)
   */
  private canFuseStage(entry: ModuleEntry, host: WasmHost): boolean {
    if (this.fusionMode === 'force-off') return false;
    if (host.fusionKind !== FUSION_KIND_PER_PIXEL_MAPPER
        && host.fusionKind !== FUSION_KIND_STRICT_OUTPUT) {
      return false;
    }
    // Either an inline WGSL string (legacy registerFusion) or a name
    // pointing to a registered SPV (new registerFusionByName). Either
    // way the host knows how to resolve to fragment WGSL.
    if (!host.fusionFragmentWgsl && !host.fusionFragmentName) return false;
    if (host.fusionUniformBufferHandle <= 0) return false;
    if (entry.taps && entry.taps.length > 0) return false;
    return true;
  }

  async ensureInstance(entry: ModuleEntry): Promise<LoadedModule> {
    // Resolve the module type early so identity comparisons are stable even
    // when entry.module_type is a fully-qualified bundle ID (e.g.
    // "com.nattos.testonly.data.particles_emitter") whose registered
    // effect id is just "data.particles_emitter".
    const found = this.findModule(entry.module_type);
    const resolvedId = found?.resolvedId ?? entry.module_type;

    let loaded = this.instances.get(entry.instance_key);
    if (loaded) {
      const currentId = loaded.host.metadata?.id ?? '';
      if (currentId !== resolvedId && currentId !== entry.module_type) {
        // Module type genuinely changed (e.g., via smart-input).
        this.instances.delete(entry.instance_key);
        loaded = undefined;
      } else {
        return loaded;
      }
    }

    const host = new WasmHost();
    host.bridgeCore = this.bridgeCore;
    host.gpuHost = this.gpuHost;
    host.onSchemaChanged = this.onHostSchemaChanged;

    if (!found) {
      throw new Error(`Module "${entry.module_type}" not registered. Load the containing bundle first.`);
    }
    await host.load(found.compiled);
    const mod = host.activateEffect(found.resolvedId);
    loaded = { host, module: mod };

    this.instances.set(entry.instance_key, loaded);
    // Visible only after wasm-hmr invalidation or first-time creation —
    // every existing instance hits the early `return loaded` above.
    console.log(`[sketch-executor] created instance ${entry.instance_key} (${resolvedId})`);
    return loaded;
  }

  getInstance(instanceKey: string): LoadedModule | undefined {
    return this.instances.get(instanceKey);
  }

  /** Iterate all loaded module hosts (for schema/io lookup). */
  allHosts(): Iterable<WasmHost> {
    const hosts: WasmHost[] = [];
    for (const { host } of this.instances.values()) hosts.push(host);
    return hosts;
  }

  /** Drop a cached instance so it will be recreated with the current module_type on next frame. */
  invalidateInstance(instanceKey: string) {
    this.instances.delete(instanceKey);
  }

  /** Register an externally-loaded module so the executor reuses it instead of loading a duplicate. */
  registerInstance(instanceKey: string, host: WasmHost, module: WasmModule) {
    if (!this.instances.has(instanceKey)) {
      this.instances.set(instanceKey, { host, module });
    }
  }

  /**
   * Ensure we have enough intermediate textures for a chain.
   * With sideband rails, each module needs its own output texture
   * (earlier outputs must remain valid for later rail reads).
   */
  private ensureIntermediates(sketchId: string, needed: number, width: number, height: number): { textures: GPUTexture[]; handles: number[] } {
    let entry = this.sketchIntermediates.get(sketchId);
    // Intermediate pool backs every stage's tex_out. Include COPY_DST (alongside
    // COPY_SRC) so an effect can gpu::Device::copy(in, out) into its output — e.g.
    // skipping a passthrough dispatch — matching the COPY_SRC|COPY_DST superset
    // that effect-created textures (gpu-host createTexture) already get.
    const texUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
                   | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
                   | GPUTextureUsage.COPY_DST;

    if (!entry) {
      entry = { textures: [], handles: [] };
      this.sketchIntermediates.set(sketchId, entry);
    }

    // Grow if needed
    while (entry.textures.length < needed) {
      const tex = this.device.createTexture({ size: [width, height], format: this.format, usage: texUsage });
      entry.textures.push(tex);
      entry.handles.push(this.gpuHost.injectTexture(tex));
    }

    // Resize if dimensions changed
    for (let i = 0; i < needed; i++) {
      const tex = entry.textures[i];
      if (tex.width !== width || tex.height !== height) {
        tex.destroy();
        const newTex = this.device.createTexture({ size: [width, height], format: this.format, usage: texUsage });
        entry.textures[i] = newTex;
        entry.handles[i] = this.gpuHost.injectTexture(newTex);
      }
    }

    return entry;
  }

  // --- Per-effect opacity wet/dry blend (mirrors native host_blend.h) ---
  private blendPipeline?: GPUComputePipeline;
  private blendUniform?: GPUBuffer;
  private blendBlack?: GPUTexture;
  private blendBlackW = 0;
  private blendBlackH = 0;

  private ensureBlendPipeline(): GPUComputePipeline {
    if (this.blendPipeline) return this.blendPipeline;
    // out = mix(dry, fx, opacity), full RGBA — byte-identical to the MSL in
    // native/src/sketch/host_blend.h. Storage format matches the intermediate
    // pool's format so the write is valid on this device.
    const wgsl = `
struct U { w: u32, h: u32, opacity: f32, pad: f32 };
@group(0) @binding(0) var dry_tex: texture_2d<f32>;
@group(0) @binding(1) var fx_tex: texture_2d<f32>;
@group(0) @binding(2) var out_tex: texture_storage_2d<${this.format}, write>;
@group(0) @binding(3) var<uniform> u: U;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.w || gid.y >= u.h) { return; }
  let c = vec2<i32>(i32(gid.x), i32(gid.y));
  let a = textureLoad(dry_tex, c, 0);
  let b = textureLoad(fx_tex, c, 0);
  textureStore(out_tex, c, mix(a, b, u.opacity));
}`;
    const module = this.device.createShaderModule({ code: wgsl });
    this.blendPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    this.blendUniform = this.device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return this.blendPipeline;
  }

  /** Zero-initialized (transparent black) texture used as the dry side when no
   * input is connected (generator fade-out). WebGPU zero-inits new textures. */
  private blackDry(width: number, height: number): GPUTexture {
    if (!this.blendBlack || this.blendBlackW !== width || this.blendBlackH !== height) {
      this.blendBlack?.destroy();
      this.blendBlack = this.device.createTexture({
        size: [width, height], format: this.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.blendBlackW = width;
      this.blendBlackH = height;
    }
    return this.blendBlack;
  }

  // Persistent transparent-black texture (with a gpuHost handle) handed to the
  // next stage when a passthrough stage (bypass / opacity 0) has NO real input —
  // e.g. a bypassed generator with nothing above it. Without this the next stage
  // inherits handle -1, doesn't render, and shows whatever stale pixels are left
  // in its reused pool slot (the generator's last frame). Zero-init = clean black.
  private emptyInputTex?: GPUTexture;
  private emptyInputHandle = -1;
  private emptyInputW = 0;
  private emptyInputH = 0;
  private emptyInput(width: number, height: number): number {
    if (!this.emptyInputTex || this.emptyInputW !== width || this.emptyInputH !== height) {
      this.emptyInputTex?.destroy();
      this.emptyInputTex = this.device.createTexture({
        size: [width, height], format: this.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
             | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.emptyInputHandle = this.gpuHost.injectTexture(this.emptyInputTex);
      this.emptyInputW = width;
      this.emptyInputH = height;
    }
    return this.emptyInputHandle;
  }

  /** Encode + submit a wet/dry opacity blend: outTex = mix(dry, fxTex, opacity). */
  private encodeWetDryBlend(
    dryHandle: number, fxTex: GPUTexture, outTex: GPUTexture,
    opacity: number, width: number, height: number,
  ) {
    const pipeline = this.ensureBlendPipeline();
    const dryTex = this.gpuHost.getTextureByHandle(dryHandle) ?? this.blackDry(width, height);
    const u = new ArrayBuffer(16);
    const dv = new DataView(u);
    dv.setUint32(0, width, true);
    dv.setUint32(4, height, true);
    dv.setFloat32(8, opacity, true);
    this.device.queue.writeBuffer(this.blendUniform!, 0, u);
    const bind = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: dryTex.createView() },
        { binding: 1, resource: fxTex.createView() },
        { binding: 2, resource: outTex.createView() },
        { binding: 3, resource: { buffer: this.blendUniform! } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Execute all columns of a sketch left-to-right, with cross-cutting rails.
   * Returns the output handle of the last column that produced output.
   */
  async executeAllColumns(
    sketchId: string,
    sketch: Sketch,
    inputTextureHandle: number,
    frameState: FrameState,
    width: number,
    height: number,
  ): Promise<number> {
    // Cross-cutting rail values persist across all columns
    const crossRailValues = new Map<string, RailValue>();
    // Shared slot counter so each module across all columns gets a unique intermediate
    const slotCounter = { value: 0 };

    // Collect column-local rail values for publishing
    const allColumnRails: Map<string, RailValue>[] = [];

    // Precompute per-rail tap-direction counts for the whole sketch.
    // The connectedness API (state::isInputConnected / isOutputConnected)
    // queries this — a write tap is "connected" iff at least one read
    // tap exists on the same rail (and vice versa). Counts per scope
    // because column-local rail IDs may collide with sketch-rail IDs;
    // we mirror the executor's resolution order (column-first).
    const railCounts = this.computeRailTapCounts(sketch);

    let lastOutput = inputTextureHandle;
    for (let colIdx = 0; colIdx < sketch.columns.length; colIdx++) {
      const column = sketch.columns[colIdx];
      const colRails = new Map<string, RailValue>();
      const colOutput = await this.executeColumn(
        sketchId, sketch, colIdx, inputTextureHandle,
        frameState, width, height, crossRailValues, slotCounter, colRails,
        railCounts);
      allColumnRails.push(colRails);
      // Only update output if this column actually contains modules
      const hasModules = column.chain.some(e => e.type === 'module');
      if (hasModules) {
        lastOutput = colOutput;
      }
    }

    // Publish all rail values to /sketch_state/{sketchId} as one write
    const sketchRailState: Record<string, any> = {};
    // Column-local rails
    for (let i = 0; i < allColumnRails.length; i++) {
      if (allColumnRails[i].size > 0) {
        sketchRailState[`columns/${i}`] = this.railValuesToJson(allColumnRails[i]);
      }
    }
    // Cross-cutting rails
    if (crossRailValues.size > 0) {
      sketchRailState.rails = this.railValuesToJson(crossRailValues);
    }
    if (Object.keys(sketchRailState).length > 0) {
      this.bridgeCore.setAt(`/sketch_state/${sketchId}`, sketchRailState);
    }

    return lastOutput;
  }

  /**
   * Walk every tap in the sketch and count, per rail, how many read and
   * write taps reference it. Used by the connectedness API to answer
   * isInputConnected / isOutputConnected without re-walking on every
   * effect query. Keys are scope-prefixed: column-local rails get
   * `c<colIdx>:<railId>`, sketch-level rails get `s:<railId>`.
   * Unresolvable rails (the tap references a missing rail) are dropped.
   */
  private computeRailTapCounts(
    sketch: Sketch,
  ): Map<string, { reads: number; writes: number }> {
    const counts = new Map<string, { reads: number; writes: number }>();
    for (let colIdx = 0; colIdx < sketch.columns.length; colIdx++) {
      const column = sketch.columns[colIdx];
      for (const entry of column.chain) {
        if (entry.type !== 'module') continue;
        for (const tap of entry.taps ?? []) {
          const key = this.railKey(sketch, colIdx, tap.railId);
          if (!key) continue;
          let c = counts.get(key);
          if (!c) { c = { reads: 0, writes: 0 }; counts.set(key, c); }
          if (tap.direction === 'read') c.reads++;
          else if (tap.direction === 'write') c.writes++;
        }
      }
    }
    return counts;
  }

  /**
   * Resolve a tap's railId to a scope-prefixed key. Mirrors the
   * column-first / sketch-fallback lookup the executor uses everywhere.
   */
  private railKey(sketch: Sketch, colIdx: number, railId: string): string | null {
    if (sketch.columns[colIdx]?.rails?.find(r => r.id === railId)) {
      return `c${colIdx}:${railId}`;
    }
    if (sketch.rails?.find(r => r.id === railId)) {
      return `s:${railId}`;
    }
    return null;
  }

  /**
   * Execute a single column's chain with sideband rail routing.
   * Cross-cutting rail values are shared across columns via crossRailValues.
   */
  async executeColumn(
    sketchId: string,
    sketch: Sketch,
    colIdx: number,
    inputTextureHandle: number,
    frameState: FrameState,
    width: number,
    height: number,
    crossRailValues: Map<string, RailValue>,
    slotCounter: { value: number },
    outColumnRails?: Map<string, RailValue>,
    railCounts?: Map<string, { reads: number; writes: number }>,
  ): Promise<number> {
    const column = sketch.columns[colIdx];
    if (!column) return inputTextureHandle;

    // Count total module entries across all columns for intermediates
    const totalModules = sketch.columns.reduce((sum, c) => sum + c.chain.filter(e => e.type === 'module').length, 0);
    const intermediates = this.ensureIntermediates(sketchId, Math.max(totalModules, 2), width, height);

    // Column-local rail values (scoped to this column's execution)
    const columnRailValues = new Map<string, RailValue>();

    let currentInputHandle = inputTextureHandle;
    // nextSlot managed via shared slotCounter

    // Accumulator for an in-progress fused run. Stages are appended as
    // we walk the chain; flushed (dispatched as one combined compute
    // pass) when the next stage isn't fusable, or when the chain ends.
    // outputHandle is updated each time a stage joins; only the LAST
    // stage's slot receives the dispatch's actual output.
    //
    // perStage carries each fused stage's {chain key, input handle,
    // intermediate output handle} so flush can:
    //   - check tracedChainEntries for any active mid-run trace,
    //   - hand the dispatcher the correct trace texture handles,
    //   - record chainEntryHandles entries for every traced stage
    //     (so the worker's chain_entry trace resolution finds them).
    let runAcc: {
      stages: FusionStage[];
      perStage: Array<{ chainKey: string; inputHandle: number; outputHandle: number }>;
      inputHandle: number;
      outputHandle: number;
    } | null = null;
    const flushFusedRun = () => {
      if (!runAcc) return;
      const acc = runAcc;
      runAcc = null;

      // Build per-stage trace-texture handles. Only NON-LAST stages
      // contribute (the last stage already writes to outputHandle —
      // that handle IS its trace texture). For each non-last stage
      // marked in `tracedChainEntries`, we point at the same
      // intermediate slot a standalone dispatch would have written.
      const traceTextureHandles: (number | null)[] = [];
      let anyTraced = false;
      for (let i = 0; i < acc.stages.length - 1; i++) {
        if (this.tracedChainEntries.has(acc.perStage[i].chainKey)) {
          traceTextureHandles.push(acc.perStage[i].outputHandle);
          anyTraced = true;
        } else {
          traceTextureHandles.push(null);
        }
      }

      this.fusionDispatcher.dispatch(
        acc.stages, acc.inputHandle, acc.outputHandle, width, height,
        anyTraced ? traceTextureHandles : undefined);
      this.debugStats.fusedRuns++;
      this.debugStats.fusedStages += acc.stages.length;

      // Record chainEntryHandles for traced stages (and the run's
      // last stage, which always has a real output). The worker's
      // chain_entry trace resolver reads from this map.
      for (let i = 0; i < acc.stages.length; i++) {
        const isLast = (i === acc.stages.length - 1);
        const traced = this.tracedChainEntries.has(acc.perStage[i].chainKey);
        if (!isLast && !traced) continue;
        this.chainEntryHandles.set(acc.perStage[i].chainKey, {
          input: acc.perStage[i].inputHandle,
          output: isLast ? acc.outputHandle : acc.perStage[i].outputHandle,
        });
      }
    };

    // chain[] holds only modules now — texture input/output are
    // implicit (the column's input handle on entry, the column's
    // output handle after the last stage flushes).
    for (let chainIdx = 0; chainIdx < column.chain.length; chainIdx++) {
      const entry = column.chain[chainIdx];
      // chain[] is module-only in current sketches, but tolerate legacy/explicit
      // texture_input / texture_output entries (the column's input/output are
      // implicit) — they carry no module_type and must not hit ensureInstance,
      // which would resolveEffectId(undefined) and throw. Mirrors the
      // `type !== 'module'` filters elsewhere in this file.
      if (entry.type !== 'module') continue;
      {
        const loaded = await this.ensureInstance(entry);

        // --- Device on/off ("bypass") ---
        // Reserved engine key in instance state. When off, fire the on_active
        // transition then alias input→output with NO state/taps/tick/render —
        // the effect goes fully dormant (Resolume "bypass"). Fire onActive only
        // on a change (the cached instance remembers the previous state).
        const reservedState = sketch.instances?.[entry.instance_key]?.state as
          Record<string, unknown> | undefined;
        const bypass = reservedState?.__bypass__ === true || reservedState?.__bypass__ === 1;
        const shouldBeActive = !bypass;
        if (loaded.active === undefined) loaded.active = true;
        if (loaded.active !== shouldBeActive) {
          loaded.active = shouldBeActive;
          loaded.module.onActive?.(shouldBeActive);
        }
        if (bypass) {
          // Passthrough the input. If there is no real input (e.g. a bypassed
          // generator with nothing above), emit a clean transparent frame so the
          // next stage renders on black instead of a stale pool slot.
          const out = currentInputHandle >= 0 ? currentInputHandle : this.emptyInput(width, height);
          this.chainEntryHandles.set(`${sketchId}/${colIdx}/${chainIdx}`, {
            input: currentInputHandle,
            output: out,
          });
          currentInputHandle = out;
          continue;
        }

        // --- Apply initial state from sketch instances (or legacy entry.params) ---
        const instanceState = sketch.instances?.[entry.instance_key]?.state ?? entry.params ?? {};
        // Post-modulation effective scalar values, used as the target for any
        // smoothing pass below. Seeded from the canonical scalars; read taps
        // overwrite the fields they modulate (so smoothing layers on top).
        const effectiveValues = new Map<string, number>();
        for (const [k, v] of Object.entries(instanceState)) {
          if (typeof v === 'number') effectiveValues.set(k, v);
        }
        const { patches: paramPatches, positional } =
          instanceStateToParams(instanceState as Record<string, unknown>);
        // Positional floats feed legacy host::param(index) reads, in order.
        for (let i = 0; i < positional.length; i++) {
          loaded.host.frameState.params[i] = positional[i];
        }
        if (paramPatches.length > 0) {
          loaded.host.notifyStatePatched(loaded.module, paramPatches);
          // Also commit to bridge core so pluginState stays in sync.
          // Without this, getPluginState() returns stale defaults for
          // input params, causing the UI to snap sliders back.
          const bc = loaded.host.bridgeCore;
          const pk = loaded.host.pluginKey;
          if (bc && pk) {
            for (const patch of paramPatches) {
              const v = patch.value;
              if (typeof v === 'number') {
                const vh = bc.valNumber(v);
                bc.commitVal(pk, patch.path, vh);
                bc.valRelease(vh);
              } else if (typeof v === 'boolean') {
                const vh = bc.valBool(v);
                bc.commitVal(pk, patch.path, vh);
                bc.valRelease(vh);
              } else if (typeof v === 'string') {
                const vh = bc.valString(v);
                bc.commitVal(pk, patch.path, vh);
                bc.valRelease(vh);
              } else if (Array.isArray(v) && v.every(x => typeof x === 'number')) {
                const arr = bc.valArray();
                for (const item of v) {
                  const itemH = bc.valNumber(item);
                  bc.valPush(arr, itemH);
                  bc.valRelease(itemH);
                }
                bc.commitVal(pk, patch.path, arr);
                bc.valRelease(arr);
              }
              // Anything else (objects, mixed-type arrays) is left for
              // the effect to handle via notifyStatePatched alone.
            }
            // Pull the committed state back into host.pluginState so the UI
            // (which reads live pluginStates broadcast each frame) reflects
            // user edits instead of stale schema defaults.
            loaded.host.pluginState = bc.getPluginState(pk);
          }
        }

        // --- Fire the on-state-ready signal exactly once ---
        // Effects register a callback in init() via state::setOnStateReady;
        // it runs after init + the initial state replay (whether that
        // replay was empty or not). Effects use it to set field
        // visibility based on the restored state, so the IDE only ever
        // sees the post-restoration schema. Idempotent — repeated calls
        // are no-ops.
        loaded.host.fireStateReady();

        // --- Reset inactive struct inputs (before read taps run) ---
        // Without this, a module that previously received data via a tap
        // keeps its cached scalar state and GPU buffer handle forever.
        // Deleting the tap should make the input appear empty / zeroed.
        this.resetInactiveStructInputs(loaded.host, loaded.module, entry);

        // --- Populate connection introspection state ---
        // For each tap on this entry, decide whether the OPPOSITE
        // direction has at least one tap on the same rail somewhere in
        // the sketch. The effect can then call state::isInputConnected
        // / isOutputConnected to skip work whose only purpose is
        // producing or consuming an unwired side rail.
        loaded.host.fieldsWithReader.clear();
        loaded.host.fieldsWithWriter.clear();
        if (entry.taps && railCounts) {
          for (const tap of entry.taps) {
            const key = this.railKey(sketch, colIdx, tap.railId);
            if (!key) continue;
            const c = railCounts.get(key);
            if (!c) continue;
            if (tap.direction === 'write' && c.reads >= 1) {
              loaded.host.fieldsWithReader.add(tap.fieldPath);
            } else if (tap.direction === 'read' && c.writes >= 1) {
              loaded.host.fieldsWithWriter.add(tap.fieldPath);
            }
          }
        }

        // --- Apply read taps (before tick/render) ---
        const inputTextures: number[] = currentInputHandle >= 0 ? [currentInputHandle] : [];

        // Drop any named-texture-tap entries the executor installed
        // last frame that aren't part of this frame's tap set. Without
        // this, removing a tap leaves a stale handle in textureFields
        // and the effect would keep resolving the freed/wrong texture.
        // Producer-published entries (state::setGpuTexture) and struct-
        // rail leaves are unaffected — they live outside this set.
        for (const key of loaded.host.tapInstalledTextureFields) {
          loaded.host.textureFields.delete(key);
        }
        loaded.host.tapInstalledTextureFields.clear();

        if (entry.taps) {
          for (const tap of entry.taps) {
            if (tap.direction !== 'read') continue;
            // Look up rail value from column-local rails first, then cross-cutting
            const rv = columnRailValues.get(tap.railId) ?? crossRailValues.get(tap.railId);
            if (!rv) continue;

            // Look up rail definition from column, then sketch
            const rail = column.rails?.find(r => r.id === tap.railId)
                      ?? sketch.rails?.find(r => r.id === tap.railId);

            if (rail?.dataType === 'float' && rv.data !== undefined) {
              // Data tap read: apply the tap's range remapper (after read), then
              // mix into the user's canonical (serialized) value per the tap's
              // mix mode. `replace` ignores the canonical (today's behavior);
              // add/mul/mix modulate from the value the user set in the UI.
              // Read the canonical from the SERIALIZED state (not the plugin's
              // runtime), so add/mul don't compound frame-over-frame.
              const shaped = applyTapMod(rv.data, tap.mod);
              const canonical = instanceState[tap.fieldPath];
              const combined = combineTap(
                typeof canonical === 'number' ? canonical : undefined,
                shaped, tap.combine, tap.mixFactor);
              loaded.host.notifyStatePatched(loaded.module, [
                { op: 'replace', path: tap.fieldPath, value: combined },
              ]);
              // Smoothing layers on top of modulation: track the post-tap value.
              effectiveValues.set(tap.fieldPath, combined);
            } else if (rail?.dataType === 'texture' && rv.texture !== undefined) {
              // Texture tap read. Numeric fieldPath → positional input
              // slot (legacy `gpu::Device::inputTexture(N)` API used by
              // video.blend etc). Named fieldPath → install directly
              // under that name in textureFields, so the effect can
              // resolve it via `gpu::Device::textureForField("<name>")`
              // — same convention as struct-rail texture leaves.
              const texIndex = parseInt(tap.fieldPath, 10);
              if (!isNaN(texIndex) && String(texIndex) === tap.fieldPath) {
                while (inputTextures.length <= texIndex) inputTextures.push(-1);
                inputTextures[texIndex] = rv.texture;
              } else if (tap.fieldPath) {
                loaded.host.textureFields.set(tap.fieldPath, rv.texture);
                loaded.host.tapInstalledTextureFields.add(tap.fieldPath);
              }
            } else if (
              typeof rail?.dataType === 'object' &&
              rail.dataType.kind === 'struct' &&
              rv.struct !== undefined
            ) {
              // Structured tap read: splice the writer's subtree into the
              // reader's state at `fieldPath`. Hoist any GPU buffer or
              // texture leaves from the struct into the reader's lookup
              // maps so bufferForField / textureForField resolve locally.
              this.applyStructRead(loaded.host, loaded.module, tap.fieldPath, rv, rail.dataType.schema);
            }
          }
        }

        // --- Apply parameter smoothing (after read taps, the outermost layer) ---
        // For each smoothing-enabled scalar field, linearly ramp toward the
        // post-modulation target and emit a final shadow-state patch — the same
        // mechanism read taps use, so the plugin sees the smoothed value while
        // the canonical (serialized) state and the UI slider stay at the target.
        const fieldOptions = entry.fieldOptions;
        if (fieldOptions) {
          loaded.smoothing ??= new Map();
          for (const [fieldPath, fo] of Object.entries(fieldOptions)) {
            const sm = fo.smoothing;
            if (!sm?.enabled) {
              loaded.smoothing.delete(fieldPath);
              continue;
            }
            const target = effectiveValues.get(fieldPath);
            if (typeof target !== 'number') continue;   // scalar floats only (v1)
            let st = loaded.smoothing.get(fieldPath);
            if (!st) {
              st = initSmooth(target, sm.duration);
              loaded.smoothing.set(fieldPath, st);
            }
            const v = advanceSmooth(st, target, sm.duration, frameState.deltaTime);
            // Settled ⇒ the plugin already holds the target; skip the redundant patch.
            if (v !== target) {
              loaded.host.notifyStatePatched(loaded.module, [
                { op: 'replace', path: fieldPath, value: v },
              ]);
            }
          }
        }

        loaded.host.inputTextureHandles = inputTextures;

        // --- Populate textureFields for unified texture access ---
        // Only reset executor-managed slots. Producer-published textures
        // (struct rail outputs written via state::setGpuTexture on
        // allocation) must persist across frames so that downstream
        // readers can still resolve them — same contract as
        // state::setGpuBuffer + gpuBufferFields, which is never cleared.
        // Wiping the whole map every frame here was silently breaking
        // optional struct-rail texture leaves like render_outputs/motion.
        loaded.host.textureFields.delete('tex_in');
        loaded.host.textureFields.delete('tex_out');
        // Drop any tex_in_N from a previous frame whose chain may have
        // had more inputs than this frame's. Bound by inputTextureHandles
        // history — fixed cap is fine since we never bind more than a
        // handful of input slots.
        for (const k of [...loaded.host.textureFields.keys()]) {
          if (k.startsWith('tex_in_')) loaded.host.textureFields.delete(k);
        }
        // Map input textures by their position names (legacy: "tex_in" for slot 0)
        if (inputTextures.length > 0 && inputTextures[0] >= 0) {
          loaded.host.textureFields.set('tex_in', inputTextures[0]);
        }
        for (let ti = 0; ti < inputTextures.length; ti++) {
          if (inputTextures[ti] >= 0) {
            loaded.host.textureFields.set(`tex_in_${ti}`, inputTextures[ti]);
          }
        }

        // --- Set frame state ---
        loaded.host.frameState.elapsedTime = frameState.elapsedTime;
        loaded.host.frameState.deltaTime = frameState.deltaTime;
        loaded.host.frameState.barPhase = frameState.barPhase;
        loaded.host.frameState.bpm = frameState.bpm;
        loaded.host.frameState.viewportW = width;
        loaded.host.frameState.viewportH = height;

        // --- Set render target (each module gets its own slot) ---
        // Grow the pool on demand: the upfront size assumes one slot per module,
        // but a partial-opacity stage consumes two (fx + blend), so later stages
        // can index past the initial allocation.
        if (slotCounter.value >= intermediates.textures.length) {
          this.ensureIntermediates(sketchId, slotCounter.value + 1, width, height);
        }
        const outputHandle = intermediates.handles[slotCounter.value];
        const outputTex = intermediates.textures[slotCounter.value];
        this.gpuHost.setSurface(outputTex, width, height);
        loaded.host.textureFields.set('tex_out', outputHandle);

        // --- Per-effect opacity (reserved engine key) ---
        // 0 → skip render (alias input), but tick still runs (the sim step);
        // 1 → normal; 0<o<1 → render then host wet/dry blend with the input.
        const rawOpacity = (instanceState as Record<string, unknown>).__opacity__;
        const opacity = typeof rawOpacity === 'number' ? rawOpacity : 1;
        loaded.host.willRender = opacity > 0;

        // --- Tick and render ---
        loaded.host.drawList = [];
        loaded.module.tick(frameState.deltaTime);

        // --- Identity skip (stateless passthrough) ---
        // An effect whose current params make it a pure passthrough
        // (output == primary input) can have its dispatch skipped and
        // its input texture aliased as its output. Only valid for
        // STATELESS effects, which the predicate enforces.
        //
        // Gated on !entryHasTaps to match the native executor: taps can
        // drive params from rails or publish outputs, which the alias
        // path doesn't handle.
        //
        // Do NOT render, do NOT consume a slot, and do NOT flush an
        // in-progress fused run — a no-op stage can sit inside a fused
        // run, so the surrounding mappers still fuse across it. Aliasing
        // input→output just leaves currentInputHandle unchanged for the
        // next stage; an all-identity chain then returns the original
        // input handle, which is the desired passthrough.
        const entryHasTaps = Array.isArray(entry.taps) && entry.taps.length > 0;
        if (!entryHasTaps && loaded.module.isIdentity()) {
          this.chainEntryHandles.set(`${sketchId}/${colIdx}/${chainIdx}`, {
            input: currentInputHandle,
            output: currentInputHandle,
          });
          this.debugStats.identitySkipped = (this.debugStats.identitySkipped | 0) + 1;
          continue;
        }

        // Fused vs standalone branch.
        //
        // 'force-on' and 'auto' group consecutive fusable stages into
        // one fused dispatch. Mappers append to whatever run is in
        // progress. StrictOutput stages must be the TOP of a run
        // (they generate pixels rather than transform them), so we
        // flush any in-progress run first and start fresh. 'force-off'
        // and effects whose canFuseStage returns false fall through
        // to the standalone render() path.
        //
        // For mapper top, we need a real input texture
        // (currentInputHandle >= 0); strict-output doesn't sample
        // input.
        const isMapperKind = loaded.host.fusionKind === FUSION_KIND_PER_PIXEL_MAPPER;
        const isStrictOutKind = loaded.host.fusionKind === FUSION_KIND_STRICT_OUTPUT;
        // Opacity != 1 forces a standalone render + host blend, so it can't fuse
        // (mirrors the native fusion-eligibility gate).
        const useFused = (this.fusionMode !== 'force-off')
                         && opacity >= 1
                         && this.canFuseStage(entry, loaded.host)
                         && (isStrictOutKind || (isMapperKind && currentInputHandle >= 0));

        // The handle this stage contributes downstream. For opacity 0 it's the
        // passthrough input; for partial opacity it's the blend result.
        let effectiveOutputHandle = outputHandle;
        let extraSlots = 0;

        if (opacity <= 0) {
          // Opacity 0: tick already advanced the sim; skip render and pass the
          // column input straight through (no slot consumed). No real input
          // (bypassed/empty generator) → emit a clean transparent frame so the
          // next stage doesn't read a stale pool slot.
          flushFusedRun();
          effectiveOutputHandle = currentInputHandle >= 0
            ? currentInputHandle : this.emptyInput(width, height);
        } else if (useFused) {
          loaded.host.firePrepare(width, height);
          const stage: FusionStage = {
            effectId: entry.module_type,
            fusionKind: loaded.host.fusionKind,
            fragmentWgsl: loaded.host.getFusionFragmentWgsl(),
            uniformBufferHandle: loaded.host.fusionUniformBufferHandle,
          };
          if (isStrictOutKind && runAcc) {
            // StrictOutput is always the top of its own run — flush
            // anything already accumulated so the new run starts
            // fresh.
            flushFusedRun();
          }
          const chainKey = `${sketchId}/${colIdx}/${chainIdx}`;
          const stageRecord = {
            chainKey,
            inputHandle: currentInputHandle,
            outputHandle,
          };
          if (!runAcc) {
            runAcc = {
              stages: [stage],
              perStage: [stageRecord],
              inputHandle: currentInputHandle,  // ignored if top is strict-output
              outputHandle: outputHandle,
            };
          } else {
            runAcc.stages.push(stage);
            runAcc.perStage.push(stageRecord);
            runAcc.outputHandle = outputHandle;
          }
        } else {
          // Stage breaks an in-progress fused run — flush so the
          // output texture chain is up-to-date before this stage runs.
          flushFusedRun();
          loaded.module.render(width, height);
          this.debugStats.standaloneDispatches++;
          if (opacity < 1) {
            // Partial opacity: blend the effect's full-strength output (the slot
            // texture, now submitted) with the column input into a fresh slot.
            const blendSlot = slotCounter.value + 1;
            if (blendSlot >= intermediates.textures.length) {
              this.ensureIntermediates(sketchId, blendSlot + 1, width, height);
            }
            this.encodeWetDryBlend(
              currentInputHandle, outputTex, intermediates.textures[blendSlot],
              opacity, width, height);
            effectiveOutputHandle = intermediates.handles[blendSlot];
            extraSlots = 1;
          }
        }
        this.debugStats.effectsExecuted++;

        // --- Apply write taps (after tick/render) ---
        if (entry.taps) {
          for (const tap of entry.taps) {
            if (tap.direction !== 'write') continue;

            // Look up rail definition from column, then sketch
            const rail = column.rails?.find(r => r.id === tap.railId)
                      ?? sketch.rails?.find(r => r.id === tap.railId);
            // Determine which rail value map to write to
            const isColumnRail = !!column.rails?.find(r => r.id === tap.railId);
            const targetRailValues = isColumnRail ? columnRailValues : crossRailValues;

            if (rail?.dataType === 'float') {
              // Read from pluginState (canonical source).
              // Falls back to instance state if module hasn't published yet.
              const value = this.readFieldFromState(loaded.host, tap.fieldPath)
                         ?? instanceState[tap.fieldPath];
              if (value !== undefined) {
                const existing = targetRailValues.get(tap.railId) ?? {};
                // Apply the tap's range remapper (before write), then fold into
                // the rail's current frame value per the tap's combine mode. The
                // first writer this frame (existing.data === undefined) just seeds.
                const shaped = applyTapMod(value as number, tap.mod);
                existing.data = combineTap(existing.data, shaped, tap.combine, tap.mixFactor);
                targetRailValues.set(tap.railId, existing);
              }
            } else if (rail?.dataType === 'texture') {
              // Texture tap write: the module's output texture goes onto the rail
              // (the post-opacity result — passthrough at 0, blended at <1).
              const existing = targetRailValues.get(tap.railId) ?? {};
              existing.texture = effectiveOutputHandle;
              targetRailValues.set(tap.railId, existing);
            } else if (
              typeof rail?.dataType === 'object' &&
              rail.dataType.kind === 'struct'
            ) {
              // Structured tap write: snapshot the writer's subtree at
              // `fieldPath`, capturing current GPU buffer handles alongside
              // scalar leaves. Mark the rail dirty if the writer emitted
              // any dirty notifications this frame under this subtree.
              const snapshot = this.snapshotStruct(
                loaded.host, tap.fieldPath, rail.dataType.schema,
              );
              const existing = targetRailValues.get(tap.railId) ?? {};
              existing.struct = snapshot.value;
              if (snapshot.dirty) existing.dirty = true;
              targetRailValues.set(tap.railId, existing);
            }
          }
        }

        // --- Record chain entry handles for trace resolution ---
        // Only standalone stages record here — fused stages set their
        // entries via flushFusedRun (and only for traced intermediate
        // stages + the run's last stage, since untraced intermediate
        // outputs aren't actually written by the fused dispatch).
        if (!useFused) {
          this.chainEntryHandles.set(`${sketchId}/${colIdx}/${chainIdx}`, {
            input: currentInputHandle,
            output: effectiveOutputHandle,
          });
        }

        // --- Advance chain ---
        currentInputHandle = effectiveOutputHandle;
        // Opacity 0 consumed no slot; partial opacity consumed an extra one
        // (fx + blend); everything else consumes exactly one.
        slotCounter.value += opacity <= 0 ? 0 : 1 + extraSlots;
      }
    }

    // Chain end — dispatch any still-pending fused run so the column's
    // last output handle is populated before the caller samples it.
    flushFusedRun();

    // Copy column rail values to output param for publishing
    if (outColumnRails) {
      for (const [k, v] of columnRailValues) outColumnRails.set(k, v);
    }

    return currentInputHandle;
  }

  private railValuesToJson(railValues: Map<string, RailValue>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [railId, rv] of railValues) {
      if (rv.data !== undefined) {
        result[railId] = { value: rv.data };
      } else if (rv.texture !== undefined) {
        result[railId] = { value: rv.texture, hasTexture: true };
      }
    }
    return result;
  }

  /**
   * Read a field value from a module's plugin state.
   * Supports paths like "output", "params/0", etc.
   */
  private readFieldFromState(host: WasmHost, fieldPath: string): number | undefined {
    let obj = host.pluginState;
    if (!obj) return undefined;

    const tokens = fieldPath.split('/').filter(t => t !== '');
    for (const token of tokens) {
      if (obj == null) return undefined;
      obj = obj[token];
    }

    return typeof obj === 'number' ? obj : undefined;
  }

  /**
   * Capture the writer's state subtree at `fieldPath` for a struct rail.
   * Returns the JSON-like value (deep-copied leaves) and a dirty flag
   * set when the writer's pendingDirtyPaths include any path under
   * `fieldPath` this frame. GPU buffer handles are pulled from the
   * writer's gpuBufferFields map rather than pluginState so that
   * handles are guaranteed to be current.
   */
  private snapshotStruct(
    host: WasmHost, fieldPath: string, schema: Record<string, any>,
  ): { value: any; dirty: boolean } {
    const base = this.readSubtree(host.pluginState, fieldPath);
    const value = this.materializeStructSnapshot(base, schema, host, fieldPath);

    const prefix = fieldPath.startsWith('/') ? fieldPath : '/' + fieldPath;
    let dirty = false;
    for (const p of host.pendingDirtyPaths) {
      const np = p.startsWith('/') ? p : '/' + p;
      if (np === prefix || np.startsWith(prefix + '/')) { dirty = true; break; }
    }
    return { value, dirty };
  }

  private materializeStructSnapshot(
    src: any, schema: Record<string, any>, host: WasmHost, pathPrefix: string,
  ): any {
    if (!schema || typeof schema !== 'object') return src;
    // `schema` here is the node itself (with .type, .fields, .gpu, etc.)
    // when invoked for an object. For a non-object top-level subtree,
    // fall through and return src directly.
    const type = (schema as any).type;
    if (type === 'object') {
      const fields = (schema as any).fields ?? {};
      const out: any = {};
      for (const [name, def] of Object.entries(fields) as [string, any][]) {
        const childPath = `${pathPrefix}/${name}`;
        const childSrc = src?.[name];
        if (def?.type === 'array' && def.gpu) {
          out[name] = host.gpuBufferFields.get(childPath) ?? 0;
        } else if (def?.type === 'texture') {
          // Producer publishes texture handles via state::setGpuTexture into
          // host.textureFields at the same slash-delimited path. Sentinel
          // -1 means the producer didn't write this optional leaf — the
          // reader's applyStructRead will skip installation.
          out[name] = host.textureFields.get(childPath) ?? -1;
        } else if (def?.type === 'object') {
          out[name] = this.materializeStructSnapshot(childSrc, def, host, childPath);
        } else {
          // leaf — clone to decouple from the writer's pluginState.
          out[name] = deepClone(childSrc);
        }
      }
      return out;
    }
    if (type === 'array' && (schema as any).gpu) {
      return host.gpuBufferFields.get(pathPrefix) ?? 0;
    }
    if (type === 'texture') {
      return host.textureFields.get(pathPrefix) ?? -1;
    }
    return deepClone(src);
  }

  /**
   * Splice a struct rail value into the reader's state at `destPath`.
   * Non-GPU leaves go through a replace patch (so module observers see
   * them). GPU buffer leaves are installed into gpuBufferFields at the
   * destination path; a dirty patch is emitted for the subtree root so
   * the reader can do lazy work without reading the subtree contents.
   */
  private applyStructRead(
    host: WasmHost, module: WasmModule, destPath: string, rv: RailValue,
    schema: Record<string, any>,
  ): void {
    const patches: import('./wasm-host').PatchOp[] = [];
    // Field-map keys (textureFields/gpuBufferFields) are stored with no
    // leading slash to match the reader convention used by texture_for_field
    // / buffer_for_field. Patches go through notifyStatePatched which is
    // path-as-given.
    const install = (value: any, def: any, path: string) => {
      if (!def) return;
      const fieldKey = stripLeadingSlash(path);
      if (def.type === 'array' && def.gpu) {
        const handle = typeof value === 'number' ? value : 0;
        host.gpuBufferFields.set(fieldKey, handle);
        return;
      }
      if (def.type === 'texture') {
        const handle = typeof value === 'number' ? value : -1;
        if (handle >= 0) host.textureFields.set(fieldKey, handle);
        return;
      }
      if (def.type === 'object') {
        const fields = def.fields ?? {};
        for (const [name, childDef] of Object.entries(fields) as [string, any][]) {
          install(value?.[name], childDef, `${path}/${name}`);
        }
        return;
      }
      // Scalar leaves ride along as a replace patch into the reader's state.
      patches.push({ op: 'replace', path: fieldKey, value });
    };
    // Walk starting from the top-level struct schema node.
    const nodeForTop = schema;
    install(rv.struct, nodeForTop, destPath.startsWith('/') ? destPath : '/' + destPath);

    // Emit a single dirty at the subtree root to trigger lazy reader work.
    patches.push({ op: 'dirty', path: destPath, value: {} });
    if (patches.length > 0) {
      host.notifyStatePatched(module, patches);
    }
  }

  private readSubtree(state: any, fieldPath: string): any {
    if (!state) return undefined;
    const tokens = fieldPath.split('/').filter(t => t !== '');
    let obj = state;
    for (const token of tokens) {
      if (obj == null) return undefined;
      obj = obj[token];
    }
    return obj;
  }

  /**
   * Reset every struct-kind input port on `entry` that has no active read
   * tap this frame. Walks the module's schema: for each top-level field
   * marked Input whose type is object / array(gpu) / texture / vec, if no
   * tap's fieldPath matches, emit reset patches for scalar leaves to
   * their schema defaults, clear installed GPU buffer handles, clear
   * texture handles, and fire a dirty patch at the subtree root so the
   * module can react to the absence.
   *
   * Scalar input fields are not reset (they're owned by the UI, not the
   * rail), nor are structured outputs (which are written by the module).
   */
  private resetInactiveStructInputs(host: WasmHost, module: WasmModule, entry: ModuleEntry): void {
    const schema = host.schema ?? {};
    if (!schema || Object.keys(schema).length === 0) return;

    const tappedReads = new Set<string>();
    for (const tap of entry.taps ?? []) {
      if (tap.direction === 'read') tappedReads.add(tap.fieldPath);
    }

    // Only reset fields whose contents are normally supplied by a rail
    // (structured objects, GPU arrays). Scalar primitives and vector
    // primitives at the top level are user-edited params; clearing them
    // on every frame with no tap would wipe user input. Textures are
    // handled separately (the textureFields map is rebuilt per frame).
    const patches: import('./wasm-host').PatchOp[] = [];
    for (const [name, def] of Object.entries(schema) as [string, any][]) {
      if (!def || typeof def !== 'object') continue;
      const io = def.io ?? 0;
      if (!(io & 1)) continue; // not an input port
      if (def.type !== 'object' && !(def.type === 'array' && def.gpu)) continue;
      if (tappedReads.has(name)) continue; // still receiving data
      this.resetInputSubtree(host, name, def, patches);
    }

    if (patches.length > 0) {
      host.notifyStatePatched(module, patches);
      const bc = host.bridgeCore;
      const pk = host.pluginKey;
      if (bc && pk) {
        for (const p of patches) {
          if (p.op !== 'replace') continue;
          if (typeof p.value === 'number') {
            const vh = bc.valNumber(p.value);
            bc.commitVal(pk, p.path, vh);
            bc.valRelease(vh);
          } else if (Array.isArray(p.value) && p.value.every(v => typeof v === 'number')) {
            const arr = bc.valArray();
            for (const item of p.value) {
              const itemH = bc.valNumber(item);
              bc.valPush(arr, itemH);
              bc.valRelease(itemH);
            }
            bc.commitVal(pk, p.path, arr);
            bc.valRelease(arr);
          }
        }
        host.pluginState = bc.getPluginState(pk);
      }
    }
  }

  private resetInputSubtree(
    host: WasmHost, path: string, def: any,
    patches: import('./wasm-host').PatchOp[],
  ): void {
    if (!def || typeof def !== 'object') return;
    const type = def.type;
    if (type === 'array' && def.gpu) {
      host.gpuBufferFields.delete(path);
      // Notify the module so it can drop any cached derived state.
      patches.push({ op: 'dirty', path, value: {} });
      return;
    }
    if (type === 'texture') {
      host.textureFields.delete(path);
      patches.push({ op: 'dirty', path, value: {} });
      return;
    }
    if (type === 'float2' || type === 'float3' || type === 'float4') {
      const n = type === 'float2' ? 2 : type === 'float3' ? 3 : 4;
      const zeros = new Array<number>(n).fill(0);
      patches.push({ op: 'replace', path, value: zeros });
      return;
    }
    if (type === 'object') {
      const fields = def.fields ?? {};
      for (const [childName, childDef] of Object.entries(fields) as [string, any][]) {
        this.resetInputSubtree(host, `${path}/${childName}`, childDef, patches);
      }
      patches.push({ op: 'dirty', path, value: {} });
      return;
    }
    // Scalar leaf inside a struct — reset to schema default.
    let def0: any = 0;
    if (type === 'bool') def0 = false;
    else if (type === 'string') def0 = '';
    else if ('default' in def) def0 = def.default;
    patches.push({ op: 'replace', path, value: def0 });
  }

  dispose() {
    this.instances.clear();
    for (const entry of this.sketchIntermediates.values()) {
      for (const tex of entry.textures) tex.destroy();
    }
    this.sketchIntermediates.clear();
  }
}
