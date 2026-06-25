/**
 * executor-host.ts — the WEB host for the unified executor.wasm.
 *
 * executor.wasm is the C++ sketch executor (native/src/sketch/sketch_executor.cpp)
 * compiled to WebAssembly — the SAME binary the native barrel runs. It owns the
 * frame loop (wire model, fusion planning, intermediate pool, delayed-wire
 * retention) and drives effects + GPU purely through two host-import ABIs:
 *
 *   - "effrt" (effrt.h): acquire an opaque instance handle for a (module_type,
 *     instance_key) and drive its params / textures / lifecycle. Here those map
 *     to web effect instances (one WasmHost + WasmModule per chain entry).
 *   - "gpu" (exec_gpu.h): a focused subset of the effect GPU ABI plus a few
 *     executor-only ops (per-stage render target, format query, submit batching,
 *     no-layout fused-chain PSO). These map onto the shared GPUHost.
 *
 * This is the web twin of native/src/sketch/executor_host.cpp + effrt_impls.cpp +
 * gpu_impls.cpp. It exposes the same surface engine-worker.ts uses on
 * SketchExecutor (executeAllColumns / invalidateInstance / invalidateFusionCacheFor)
 * so it can be swapped in behind a flag and gated on pixel parity.
 *
 * KEY async/sync seam: executor_execute is SYNCHRONOUS and calls effrt_instance_for
 * mid-frame, but creating a web effect instance (WebAssembly.instantiate) is ASYNC.
 * So executeAllColumns pre-creates every chain entry's instance (await) BEFORE
 * driving the wasm executor; effrt_instance_for then just looks one up.
 */
import { GPUHost } from './gpu-host';
import { WasmHost, WasmModule, PatchOp } from './wasm-host';
import { composeWgsl, FusionStage } from './fusion-dispatcher';
import { sketchChain, Sketch } from './sketch-types';
import { createWasiShim } from './wasi-shim';
import type { BridgeCore } from './bridge-core';

interface FrameState {
  elapsedTime: number;
  deltaTime: number;
  barPhase: number;
  bpm: number;
}

function makeZeroStats(): import('./engine-types').DebugStats {
  return { effectsExecuted: 0, standaloneDispatches: 0, fusedRuns: 0,
           fusedStages: 0, dispatchesSaved: 0, gpuDispatches: 0, identitySkipped: 0 };
}

interface WebEffectInstance {
  host: WasmHost;
  module: WasmModule;
  moduleType: string;
  resolvedId: string;
}

interface ExecutorExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  __wasm_call_ctors?(): void;
  executor_create(): number;
  executor_destroy(ex: number): void;
  executor_register_schema(ex: number, mt: number, mtLen: number,
                           schema: number, schemaLen: number): void;
  executor_register_capabilities(ex: number, mt: number, mtLen: number,
                                 caps: number, capsLen: number): void;
  executor_execute(ex: number, sketch: number, sketchLen: number,
                   inTex: number, outTex: number, w: number, h: number,
                   dt: number, dirty: number): number;
  executor_set_fusion_enabled(ex: number, enabled: number): void;
  executor_set_automation(ex: number, json: number, len: number): void;
  executor_debug_stats(ex: number, out: number): void;
  executor_modulation_json(ex: number, out: number, cap: number): number;
}

// Per-sketch executor C++ instance: separate intermediate pool / delayed-wire
// state / fused-PSO cache / schema set, so concurrent sketches don't collide.
interface SketchSlot {
  exPtr: number;
  lastJson: string;
  registeredSchemas: Set<string>;
  outputTex: number;   // GPUHost handle of the RGBA8 destination texture
  outW: number;
  outH: number;
  /** Instance keys this executor has ever applied state for (mirrors its native
   *  `lastAppliedState_`). If a key here is recreated as a FRESH web instance
   *  (after a prune), the native state cache is stale → rebuild the slot. */
  appliedKeys: Set<string>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class WasmSketchExecutor {
  private exports!: ExecutorExports;
  private get memory(): WebAssembly.Memory { return this.exports.memory; }

  // Effect instances, keyed by chain-entry instance_key (stable across frames).
  private instances = new Map<string, WebEffectInstance>();
  /** Keys whose instance is mid-instantiation (async WASM compile). A pending key
   *  is NOT "missing" — without tracking it, the per-frame drive + the reviving
   *  check would destroy + respawn it every frame (1000s of instances) before it
   *  ever finishes. Used to dedup concurrent creates AND to exempt it from revive. */
  private inflight = new Map<string, Promise<WebEffectInstance | null>>();
  // Frame-local handle table the effrt imports resolve against. Cleared each
  // executeAllColumns; effrt_instance_for assigns indices as the executor asks.
  private byHandle: WebEffectInstance[] = [];
  private handleByKey = new Map<string, number>();

  private slots = new Map<string, SketchSlot>();

  // Fusion on/off, applied to every executor slot (mirrors the web debug
  // `setFusionMode` toggle). force-off → false; auto / force-on → true (the C++
  // executor has no length-1 "force-on" mode — it fuses runs of 2+, so force-on
  // collapses to auto). Applied to each slot when it's created + retroactively
  // when the mode changes.
  private fusionEnabled = true;

  // Per-frame debug counters, accumulated across every sketch's executor_execute
  // and drained by consumeDebugStats() (called once per frame). The C++ executor
  // resets its own counters at the top of each execute() and reports the last
  // frame's via the `executor_debug_stats` export; summing here gives a true
  // single-frame total across all sketches, matching the old TS executor.
  private frameStats = makeZeroStats();
  // Reused 7×i32 scratch in the executor's linear memory (lazily malloc'd) that
  // executor_debug_stats writes into; the view is rebuilt each read since malloc
  // can detach the ArrayBuffer.
  private statsScratch = 0;

  // Called when an effect host's schema changes at runtime (lazy registration
  // after the first frame). The worker wires this to markDirty so the plugin
  // defs re-broadcast. Mirrors SketchExecutor.onHostSchemaChanged.
  onHostSchemaChanged?: () => void;

  // Editor-preview surface (same shape SketchExecutor exposes): per-frame chain
  // entry texture handles + the set of monitored entries (forces a fused-group
  // barrier so the requested intermediate lands in a real texture). The worker
  // clears chainEntryHandles + fills tracedChainEntries each frame; the executor
  // reports back through the "trace" host imports below.
  chainEntryHandles = new Map<string, { input: number; output: number }>();
  tracedChainEntries = new Set<string>();
  private currentSketchId = '';

  constructor(
    private bridgeCore: BridgeCore,
    private gpuHost: GPUHost,
    private device: GPUDevice,
    private format: GPUTextureFormat,
    private findModule: (effectId: string) => { compiled: WebAssembly.Module; resolvedId: string } | null,
  ) {}

  /** Fetch + instantiate executor.wasm and create nothing else yet. */
  async init(url = '/wasm/executor.wasm'): Promise<void> {
    const resp = await fetch(url);
    const bytes = await resp.arrayBuffer();
    const importObject: WebAssembly.Imports = {
      wasi_snapshot_preview1: createWasiShim(() => this.memory),
      gpu: this.buildGpuImports(),
      effrt: this.buildEffrtImports(),
      trace: this.buildTraceImports(),
    };
    const { instance } = await WebAssembly.instantiate(bytes, importObject);
    this.exports = instance.exports as unknown as ExecutorExports;
    // Run C++ global constructors (the module is a WASI command but we never
    // call _start; ctors run here, no proc_exit). No-op if not exported.
    this.exports.__wasm_call_ctors?.();
  }

  // ---- memory marshalling (executor.wasm linear memory) ----
  private readString(ptr: number, len: number): string {
    if (len <= 0) return '';
    return decoder.decode(new Uint8Array(this.memory.buffer, ptr, len));
  }
  /** Write a string into out[0..cap); return its FULL byte length (may exceed cap). */
  private writeStringInto(out: number, cap: number, s: string): number {
    const bytes = encoder.encode(s);
    if (out && cap > 0) {
      const n = Math.min(bytes.length, cap);
      if (n > 0) new Uint8Array(this.memory.buffer, out, n).set(bytes.subarray(0, n));
    }
    return bytes.length;
  }

  // ---- instance lifecycle ----
  /**
   * Ensure a web effect instance exists for `key` (module type `mt`). Mirrors
   * SketchExecutor.ensureInstance: a fresh WasmHost wired to the shared
   * gpuHost/bridgeCore, then load + activateEffect. Async (WebAssembly.instantiate).
   */
  private async ensureInstance(mt: string, key: string): Promise<WebEffectInstance | null> {
    const found = this.findModule(mt);
    const resolvedId = found?.resolvedId ?? mt;
    const existing = this.instances.get(key);
    if (existing) {
      // Reuse unless the device's TYPE actually changed (smart-input retype).
      // Compare the stored moduleType — NOT host.metadata.id, which falls back to
      // '' when metadata isn't populated and then mismatches every frame, deleting
      // + recreating the instance forever (1000s of "module initialized").
      if (existing.moduleType === mt) return existing;
      this.instances.delete(key);  // module type changed (smart-input) — rebuild
    }
    if (!found) return null;
    // Dedup concurrent creates: WASM instantiation is async (>1 frame), and the
    // per-frame drive re-enters here before it finishes — return the same promise.
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const host = new WasmHost();
      host.bridgeCore = this.bridgeCore;
      host.gpuHost = this.gpuHost;
      host.onSchemaChanged = this.onHostSchemaChanged;
      await host.load(found.compiled);
      const module = host.activateEffect(found.resolvedId);
      const inst: WebEffectInstance = { host, module, moduleType: mt, resolvedId };
      this.instances.set(key, inst);
      return inst;
    })();
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  invalidateInstance(instanceKey: string): void {
    this.instances.delete(instanceKey);
  }

  /**
   * Drop a sketch's executor slot entirely (frees the native executor + its
   * per-instance pool). The next `executeAllColumns` re-creates a fresh slot, so
   * a sketch re-issued later with an IDENTICAL structure still runs from scratch.
   * Without this, deleting + recreating the same sketch (e.g. the arrangement's
   * composite as the playhead leaves and re-enters a clip) leaves the cached
   * `lastJson` matching → `dirty=0` → a time-independent effect's stale instance
   * reports identity → renders as passthrough.
   */
  deleteSketch(sketchId: string): void {
    const slot = this.slots.get(sketchId);
    if (!slot) return;
    this.destroySlot(slot);
    this.slots.delete(sketchId);
  }

  /**
   * Drop chain-entry instances no longer referenced by ANY live sketch, freeing
   * their WASM instance for GC. Bounds memory when a sketch's chain churns — e.g.
   * the arrangement's single combined composite as clips become active/inactive
   * (and split mints new clip ids); without this the executor accumulates an
   * instance per clip/device ever composited → WASM out-of-memory.
   */
  pruneInstancesExcept(liveKeys: Set<string>): void {
    for (const key of [...this.instances.keys()]) {
      if (!liveKeys.has(key)) this.instances.delete(key);
    }
  }

  /** Live module for a chain-entry key (matches SketchExecutor.getInstance) —
   *  lets the worker's setParam direct-poke fast path + debugDump reach the
   *  effect instances when executor.wasm is the active executor. */
  getInstance(instanceKey: string): WebEffectInstance | undefined {
    return this.instances.get(instanceKey);
  }

  /** Iterate all loaded module hosts (schema / io-decl lookup after HMR). */
  allHosts(): Iterable<WasmHost> {
    const hosts: WasmHost[] = [];
    for (const { host } of this.instances.values()) hosts.push(host);
    return hosts;
  }

  /** Register an externally-loaded module (an anchor/real module that's also a
   *  chain entry) so executeAllColumns reuses it instead of instantiating a
   *  duplicate. Mirrors SketchExecutor.registerInstance; moduleType is recovered
   *  from the host metadata so the change-detection in ensureInstance still
   *  works and the sketch-state mirror / trace get the right effect id. */
  registerInstance(instanceKey: string, host: WasmHost, module: WasmModule): void {
    if (this.instances.has(instanceKey)) return;
    const mt = host.metadata?.id ?? '';
    this.instances.set(instanceKey, { host, module, moduleType: mt, resolvedId: mt });
  }

  invalidateFusionCacheFor(_effectId: string): void {
    // The fused-PSO cache lives INSIDE executor.wasm (keyed by module-type
    // sequence). We can't selectively evict it from here, so on an HMR reload of
    // an effect we drop the live instances (invalidateInstance, called by the
    // worker) and recreate the whole executor so its caches reset cleanly.
    for (const slot of this.slots.values()) {
      this.destroySlot(slot);
    }
    this.slots.clear();
  }

  // Live published state per instance (effect set_val outputs) — drives the
  // inspector readouts and the wire/value spark charts (web reads producer
  // outputs from here, not /sketch_state). Same as SketchExecutor.getPluginStates.
  getPluginStates(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, inst] of this.instances) {
      const ps = inst.host.pluginState;
      if (ps && Object.keys(ps).length > 0) result[key] = ps;
    }
    return result;
  }

  // Reusable scratch buffer in the executor's linear memory for the modulation
  // JSON readback (grown on demand). malloc can detach the ArrayBuffer, so the
  // pointer is re-validated by reading right after the call that fills it.
  private modScratch = 0;
  private modScratchCap = 0;

  // Per-frame modulation telemetry (per modulated scalar input: effective value
  // + swing band), merged across sketch slots. Keyed by instance_key, same shape
  // as getPluginStates so the worker can diff it the same way. Drives the slider
  // modulation band. Computed inside executor.wasm (executor_modulation_json) so
  // the math is identical to native.
  getModulationData(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const slot of this.slots.values()) {
      if (this.modScratchCap === 0) {
        this.modScratchCap = 4096;
        this.modScratch = this.exports.malloc(this.modScratchCap);
      }
      let n = this.exports.executor_modulation_json(slot.exPtr, this.modScratch, this.modScratchCap);
      if (n > this.modScratchCap) {
        this.exports.free(this.modScratch);
        this.modScratchCap = n + 256;
        this.modScratch = this.exports.malloc(this.modScratchCap);
        n = this.exports.executor_modulation_json(slot.exPtr, this.modScratch, this.modScratchCap);
      }
      if (n <= 2) continue;  // "" or "{}" → nothing modulated in this slot
      try {
        const obj = JSON.parse(this.readString(this.modScratch, n));
        for (const k in obj) result[k] = obj[k];
      } catch { /* malformed dump — skip this frame */ }
    }
    return result;
  }

  // Drain each instance's effect console output (state::log / console_log).
  drainConsoleLogs(): import('./engine-types').DebugConsoleEntry[] {
    const out: import('./engine-types').DebugConsoleEntry[] = [];
    for (const [instanceKey, inst] of this.instances) {
      const host = inst.host;
      if (host.consoleLogs.length === 0) continue;
      const moduleId = host.metadata?.id ?? instanceKey;
      for (const e of host.consoleLogs) {
        out.push({ instanceKey, moduleId, timestamp: e.timestamp,
                   level: e.level, message: e.message, data: e.data });
      }
      host.consoleLogs = [];
    }
    return out;
  }

  // Drain the per-frame debug counters accumulated across this frame's
  // executor_execute calls (fed by accumulateDebugStats) and reset for the next
  // frame, so each sample is a true single-frame count. The worker calls this
  // every frame (the reset bounds the counters) and ships it to the Debug Info
  // panel on a throttle.
  consumeDebugStats(): import('./engine-types').DebugStats {
    const s = this.frameStats;
    this.frameStats = makeZeroStats();
    return s;
  }

  private slotFor(sketchId: string): SketchSlot {
    let slot = this.slots.get(sketchId);
    if (!slot) {
      const exPtr = this.exports.executor_create();
      // Apply the current fusion toggle to the fresh executor (default is on).
      if (!this.fusionEnabled) this.exports.executor_set_fusion_enabled(exPtr, 0);
      slot = { exPtr, lastJson: '',
               registeredSchemas: new Set(), outputTex: 0, outW: 0, outH: 0,
               appliedKeys: new Set() };
      this.slots.set(sketchId, slot);
    }
    return slot;
  }

  /** Debug fusion toggle (mirrors SketchExecutor.setFusionMode). force-off
   *  disables GPU fusion; auto / force-on enable it. Applied to all live slots
   *  + remembered for slots created later. */
  setFusionMode(mode: 'auto' | 'force-on' | 'force-off'): void {
    this.fusionEnabled = mode !== 'force-off';
    for (const slot of this.slots.values()) {
      this.exports.executor_set_fusion_enabled(slot.exPtr, this.fusionEnabled ? 1 : 0);
    }
  }

  /** Push this frame's parameter automation (a JSON array of
   *  {instance,field,value,combine,magnitude}) to every live slot. The executor
   *  folds it through tap_mod against each field's schema range. Entries whose
   *  instance isn't in a slot's chain are ignored, so one batch is safe across
   *  slots. Empty array clears. */
  setAutomation(json: string): void {
    const bytes = encoder.encode(json);
    const ptr = this.exports.malloc(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    for (const slot of this.slots.values()) {
      this.exports.executor_set_automation(slot.exPtr, ptr, bytes.length);
    }
    this.exports.free(ptr);
  }

  /**
   * Fully tear down a slot: RELEASE its output texture (a ~W×H RGBA8 GPU texture)
   * THEN destroy the native executor. Forgetting the texture release here leaked
   * one per slot teardown — and the per-frame "reviving" rebuild can destroy a
   * slot every time the playhead crosses a clip boundary → GPU/WASM OOM.
   */
  private destroySlot(slot: SketchSlot): void {
    if (slot.outputTex) { this.gpuHost.release(slot.outputTex); slot.outputTex = 0; }
    this.exports.executor_destroy(slot.exPtr);
  }

  private ensureOutputTexture(slot: SketchSlot, w: number, h: number): number {
    if (slot.outputTex && slot.outW === w && slot.outH === h) return slot.outputTex;
    if (slot.outputTex) this.gpuHost.release(slot.outputTex);
    slot.outputTex = this.gpuHost.createTexture(w, h, /*RGBA8*/ 1);
    slot.outW = w; slot.outH = h;
    return slot.outputTex;
  }

  /**
   * Drive one frame of one sketch through executor.wasm. Returns the output
   * texture handle (or `inputHandle` for a passthrough). Same signature as
   * SketchExecutor.executeAllColumns.
   */
  async executeAllColumns(
    sketchId: string, sketch: Sketch, inputHandle: number,
    frameState: FrameState, width: number, height: number,
    /** Called once this frame's instances are ensured (created/revived) but BEFORE the
     *  native drive — so the host can (re)bind per-instance input textures onto the
     *  fresh instances, else a just-created instance renders with unbound slots. */
    onInstancesReady?: () => void): Promise<number> {
    this.currentSketchId = sketchId;
    let slot = this.slotFor(sketchId);
    const chain = sketchChain(sketch);

    // Stale-state guard: a chain entry whose web instance is GONE (pruned while
    // it was out of the chain) will be recreated fresh below with DEFAULT params.
    // If this executor already applied that key's state, its native
    // `lastAppliedState_` still matches the new (default) JSON → the per-key
    // apply is skipped → the effect runs with default params (e.g. a
    // brightness=1.0 effect collapses to identity on a clip's 2nd activation).
    // Rebuild the slot so ALL state re-applies from scratch. Rare (only when a
    // previously-seen instance re-enters the chain — a clip boundary re-cross).
    const reviving = chain.some(
      (e) => e.type === 'module' && !this.instances.has(e.instance_key)
        && !this.inflight.has(e.instance_key) // mid-instantiation, not pruned — don't tear it down
        && slot.appliedKeys.has(e.instance_key),
    );
    if (reviving) {
      this.destroySlot(slot);
      this.slots.delete(sketchId);
      slot = this.slotFor(sketchId);
    }

    // 1. Pre-create every chain entry's instance, push its schema once, and
    //    thread the frame state onto its host (effrt drives tick/render which
    //    read host.frameState).
    for (const entry of chain) {
      const inst = await this.ensureInstance(entry.module_type, entry.instance_key);
      if (!inst) continue;
      const fs = inst.host.frameState;
      fs.elapsedTime = frameState.elapsedTime;
      fs.deltaTime = frameState.deltaTime;
      fs.barPhase = frameState.barPhase;
      fs.bpm = frameState.bpm;
      fs.viewportW = width;
      fs.viewportH = height;
      if (!slot.registeredSchemas.has(entry.module_type)) {
        const fields = JSON.stringify(inst.host.schema ?? {});
        const mtBytes = encoder.encode(entry.module_type);
        const scBytes = encoder.encode(fields);
        const mtPtr = this.exports.malloc(mtBytes.length);
        const scPtr = this.exports.malloc(scBytes.length);
        new Uint8Array(this.memory.buffer, mtPtr, mtBytes.length).set(mtBytes);
        new Uint8Array(this.memory.buffer, scPtr, scBytes.length).set(scBytes);
        this.exports.executor_register_schema(slot.exPtr, mtPtr, mtBytes.length, scPtr, scBytes.length);
        this.exports.free(mtPtr);
        this.exports.free(scPtr);
        // Push the declarative capability tags alongside the schema — the
        // executor gates modulation auto-connect on them (modulation_source /
        // modulation_shaper). Separate call so the schema contract is untouched.
        const caps = JSON.stringify(inst.host.capabilities ?? []);
        const cMtBytes = encoder.encode(entry.module_type);
        const cBytes = encoder.encode(caps);
        const cMtPtr = this.exports.malloc(cMtBytes.length);
        const cPtr = this.exports.malloc(cBytes.length);
        new Uint8Array(this.memory.buffer, cMtPtr, cMtBytes.length).set(cMtBytes);
        new Uint8Array(this.memory.buffer, cPtr, cBytes.length).set(cBytes);
        this.exports.executor_register_capabilities(slot.exPtr, cMtPtr, cMtBytes.length, cPtr, cBytes.length);
        this.exports.free(cMtPtr);
        this.exports.free(cPtr);
        slot.registeredSchemas.add(entry.module_type);
      }
    }

    // Instances for this frame now exist (created/revived above). Let the host bind
    // per-instance input textures NOW, so a freshly-created instance doesn't render a
    // frame with unbound slots (the video→solid flash).
    onInstancesReady?.();

    // 2. Reset the frame-local handle table (effrt_instance_for repopulates it).
    this.byHandle = [];
    this.handleByKey.clear();

    // 3. Mirror each instance's live published OUTPUT scalars (written via
    //    state::set_val during last frame's tick) into the sketch state the
    //    executor reads. Float write-taps (captureWriteTaps) source a producer's
    //    scalar from instances[key].state[field], NOT the live runtime — so a
    //    scalar wire (e.g. mod.source.lfo.output → param) is invisible unless the
    //    output is present here. 1-frame latency, matching the native barrel's
    //    sketch-state mirroring. Built on a shallow copy; the input sketch and
    //    the structural dirty check below are untouched.
    let execInstances = sketch.instances;
    let mirrored = false;
    for (const entry of chain) {
      const inst = this.instances.get(entry.instance_key);
      const ps = inst?.host.pluginState;
      const schema = inst?.host.schema;
      if (!inst || !ps || typeof ps !== 'object' || !schema) continue;
      const outs: Record<string, number> = {};
      for (const fname in schema) {
        const def: any = schema[fname];
        const io = def?.io ?? 0;
        // PURE output fields only. A field that is ALSO an input (a "relay" —
        // both io bits, e.g. a util.dashboard knob) is AUTHORED, not engine-
        // published; mirroring the effect's (uncomputed) output over it would
        // clobber the user's value and break its output wire.
        if (!((io & 2) && !(io & 1))) continue;
        if (def?.type === 'object' || def?.type === 'array' || def?.type === 'texture') continue;
        const v = ps[fname];
        if (typeof v === 'number') outs[fname] = v;
        else if (typeof v === 'boolean') outs[fname] = v ? 1 : 0;
      }
      if (Object.keys(outs).length === 0) continue;
      if (!mirrored) { execInstances = { ...(sketch.instances ?? {}) }; mirrored = true; }
      const orig: any = (sketch.instances as any)?.[entry.instance_key] ?? { module_type: inst.moduleType };
      execInstances![entry.instance_key] = { ...orig, state: { ...(orig.state ?? {}), ...outs } };
    }
    const execSketch = mirrored ? { ...sketch, instances: execInstances } : sketch;

    // 4. Marshal the sketch JSON + drive. dirty rebuilds the plan; detect via a
    //    STRUCTURAL diff (the input sketch, not the mirrored outputs) so an
    //    animating producer doesn't force a plan rebuild every frame.
    const structuralJson = JSON.stringify(sketch);
    const dirty = structuralJson !== slot.lastJson;
    slot.lastJson = structuralJson;
    // On a dirty frame the native executor (re)applies state for every chain
    // entry — remember those keys so we can detect a later prune+revive.
    if (dirty) for (const e of chain) if (e.type === 'module') slot.appliedKeys.add(e.instance_key);
    const outTex = this.ensureOutputTexture(slot, width, height);

    const json = JSON.stringify(execSketch);
    const jbytes = encoder.encode(json);
    const jptr = this.exports.malloc(jbytes.length);
    new Uint8Array(this.memory.buffer, jptr, jbytes.length).set(jbytes);
    let outHandle = inputHandle;
    try {
      outHandle = this.exports.executor_execute(
        slot.exPtr, jptr, jbytes.length, inputHandle, outTex,
        width, height, frameState.deltaTime, dirty ? 1 : 0);
    } finally {
      this.exports.free(jptr);
    }
    this.accumulateDebugStats(slot.exPtr);
    return outHandle;
  }

  // Read this executor's last-frame debug counters and fold them into the
  // per-frame accumulator. One executor_execute per sketch per frame → summing
  // across slots gives the whole-frame total consumeDebugStats() drains.
  private accumulateDebugStats(exPtr: number): void {
    if (!this.statsScratch) this.statsScratch = this.exports.malloc(7 * 4);
    this.exports.executor_debug_stats(exPtr, this.statsScratch);
    const a = new Int32Array(this.memory.buffer, this.statsScratch, 7);
    const s = this.frameStats;
    s.effectsExecuted += a[0];
    s.standaloneDispatches += a[1];
    s.fusedRuns += a[2];
    s.fusedStages += a[3];
    s.dispatchesSaved += a[4];
    s.gpuDispatches += a[5];
    s.identitySkipped += a[6];
  }

  // ---- effrt host imports (mirror native/src/sketch/effrt_impls.cpp) ----
  private resolve(h: number): WebEffectInstance | null {
    return (h >= 0 && h < this.byHandle.length) ? this.byHandle[h] : null;
  }

  private buildEffrtImports(): WebAssembly.ModuleImports {
    return {
      instance_for: (mtPtr: number, mtLen: number, keyPtr: number, keyLen: number): number => {
        const key = this.readString(keyPtr, keyLen);
        const inst = this.instances.get(key);
        if (!inst) return -1;
        const cached = this.handleByKey.get(key);
        if (cached !== undefined) return cached;
        const h = this.byHandle.length;
        this.byHandle.push(inst);
        this.handleByKey.set(key, h);
        return h;
      },
      set_param_float: (h: number, pathPtr: number, pathLen: number, v: number) => {
        const i = this.resolve(h); if (!i) return;
        i.host.notifyStatePatched(i.module, [{ op: 'replace', path: this.readString(pathPtr, pathLen), value: v }]);
      },
      set_param_json: (h: number, pathPtr: number, pathLen: number, jPtr: number, jLen: number) => {
        const i = this.resolve(h); if (!i) return;
        const value = JSON.parse(this.readString(jPtr, jLen));
        i.host.notifyStatePatched(i.module, [{ op: 'replace', path: this.readString(pathPtr, pathLen), value }]);
      },
      set_param_array: (h: number, pathPtr: number, pathLen: number, compsPtr: number, n: number) => {
        const i = this.resolve(h); if (!i) return;
        const value = Array.from(new Float32Array(this.memory.buffer, compsPtr, n));
        i.host.notifyStatePatched(i.module, [{ op: 'replace', path: this.readString(pathPtr, pathLen), value }]);
      },
      set_texture_field: (h: number, pathPtr: number, pathLen: number, tex: number) => {
        const i = this.resolve(h); if (!i) return;
        i.host.textureFields.set(this.readString(pathPtr, pathLen), tex);
      },
      texture_field: (h: number, pathPtr: number, pathLen: number): number => {
        const i = this.resolve(h); if (!i) return -1;
        return i.host.textureFields.get(this.readString(pathPtr, pathLen)) ?? -1;
      },
      // GPU storage-buffer struct-rail leaves (mirror effrt_set_buffer_field /
      // effrt_buffer_field). Read off the producer's gpuBufferFields (published
      // by its state::setGpuBuffer) and bound onto the consumer's input field,
      // which the consumer resolves via gpu::bufferForField.
      set_buffer_field: (h: number, pathPtr: number, pathLen: number, buf: number) => {
        const i = this.resolve(h); if (!i) return;
        i.host.gpuBufferFields.set(this.readString(pathPtr, pathLen), buf);
      },
      buffer_field: (h: number, pathPtr: number, pathLen: number): number => {
        const i = this.resolve(h); if (!i) return 0;
        return i.host.gpuBufferFields.get(this.readString(pathPtr, pathLen)) ?? 0;
      },
      set_input_texture_slots: (h: number, handlesPtr: number, n: number) => {
        const i = this.resolve(h); if (!i) return;
        i.host.inputTextureHandles = Array.from(new Int32Array(this.memory.buffer, handlesPtr, n));
      },
      set_field_connected: (h: number, pathPtr: number, pathLen: number, input: number, output: number) => {
        const i = this.resolve(h); if (!i) return;
        const path = this.readString(pathPtr, pathLen);
        if (input) i.host.fieldsWithWriter.add(path); else i.host.fieldsWithWriter.delete(path);
        if (output) i.host.fieldsWithReader.add(path); else i.host.fieldsWithReader.delete(path);
      },
      set_will_render: (h: number, v: number) => {
        const i = this.resolve(h); if (i) i.host.willRender = v !== 0;
      },
      tick: (h: number, dt: number) => {
        const i = this.resolve(h); if (i) i.module.tick(dt);
      },
      render: (h: number, w: number, vh: number) => {
        const i = this.resolve(h); if (i) i.module.render(w, vh);
      },
      prepare: (h: number, w: number, vh: number) => {
        const i = this.resolve(h); if (i) i.host.firePrepare(w, vh);
      },
      set_active: (h: number, active: number) => {
        const i = this.resolve(h); if (i) i.module.onActive?.(active !== 0);
      },
      // Seek/prefill a stateful effect to a target time (mirrors effrt_seek /
      // EffectInstance::doSeek). Declared ABI — no executor caller yet.
      seek: (h: number, from: number, to: number) => {
        const i = this.resolve(h); if (i) i.module.seek?.(from, to);
      },
      is_identity: (h: number): number => {
        const i = this.resolve(h); return (i && i.module.isIdentity()) ? 1 : 0;
      },
      fusion_kind: (h: number): number => {
        const i = this.resolve(h); return i ? i.host.fusionKind : 0;
      },
      fusion_has_prepare: (h: number): number => {
        const i = this.resolve(h); return (i && i.host.fusionPrepareIdx) ? 1 : 0;
      },
      fusion_uniform_buffer: (h: number): number => {
        const i = this.resolve(h); return i ? i.host.fusionUniformBufferHandle : 0;
      },
      fusion_fragment_name: (h: number, out: number, cap: number): number => {
        const i = this.resolve(h); if (!i) return 0;
        return this.writeStringInto(out, cap, i.host.fusionFragmentName);
      },
      build_fused_source: (instsPtr: number, count: number, out: number, cap: number): number => {
        const handles = new Int32Array(this.memory.buffer, instsPtr, count);
        const stages: FusionStage[] = [];
        for (let k = 0; k < count; k++) {
          const i = this.resolve(handles[k]);
          if (!i) return 0;
          const wgsl = i.host.getFusionFragmentWgsl();
          if (!wgsl) return 0;
          stages.push({
            effectId: i.moduleType,
            fusionKind: i.host.fusionKind,
            fragmentWgsl: wgsl,
            uniformBufferHandle: i.host.fusionUniformBufferHandle,
          });
        }
        // composeWgsl emits `fn main`; the executor builds the PSO with entry
        // "fused_main" (gpu_create_compute_pso) — rename to match.
        const src = composeWgsl(stages, []).replace(
          /@compute([\s\S]*?)fn main\(/, '@compute$1fn fused_main(');
        return this.writeStringInto(out, cap, src);
      },
    };
  }

  // ---- trace host imports (editor preview: exec_trace.h) ----
  private buildTraceImports(): WebAssembly.ModuleImports {
    return {
      chain_entry: (colIdx: number, chainIdx: number, input: number, output: number,
                    _w: number, _h: number) => {
        this.chainEntryHandles.set(`${this.currentSketchId}/${colIdx}/${chainIdx}`,
                                   { input, output });
      },
      sketch_output: (_handle: number, _w: number, _h: number) => { /* return value already carries it */ },
      is_barrier: (colIdx: number, chainIdx: number): number =>
        this.tracedChainEntries.has(`${this.currentSketchId}/${colIdx}/${chainIdx}`) ? 1 : 0,
    };
  }

  // ---- gpu host imports (mirror exec_gpu.h over the shared GPUHost) ----
  private buildGpuImports(): WebAssembly.ModuleImports {
    const g = this.gpuHost;
    return {
      create_texture: (w: number, h: number, fmt: number): number => g.createTexture(w, h, fmt),
      release: (h: number) => g.release(h),
      copy_texture: (src: number, dst: number) => g.copyTexture(src, dst),
      clear_texture: (tex: number, r: number, gr: number, b: number, a: number) => g.clearTexture(tex, r, gr, b, a),
      set_surface: (tex: number, w: number, h: number) => {
        const t = g.getTextureByHandle(tex);
        if (t) g.setSurface(t, w, h);
      },
      get_texture_format: (h: number): number => g.getTextureFormatCode(h),
      // Live backend code (1 = WebGPU here). The executor's wet/dry blend picks
      // WGSL vs MSL from this — without it the blend would feed MSL to WebGPU.
      get_backend: (): number => g.getBackend(),
      // The executor batches the whole frame between begin/end_submit_batch.
      // GPUHost accumulates into one lazily-created encoder and never flushes
      // mid-frame on its own, so begin is a no-op and end flushes once.
      begin_submit_batch: () => { /* no-op: encoder accumulates */ },
      end_submit_batch: () => g.flush(),
      create_shader_module: (srcPtr: number, srcLen: number): number =>
        g.createShaderModule(this.readString(srcPtr, srcLen)),
      create_compute_pso: (shader: number, entryPtr: number, entryLen: number): number =>
        g.createComputePipelineAuto(shader, this.readString(entryPtr, entryLen)),
      create_buffer: (size: number, usage: number): number => g.createBuffer(size, usage),
      write_buffer: (buf: number, offset: number, dataPtr: number, dataLen: number) => {
        const data = new Uint8Array(this.memory.buffer, dataPtr, dataLen).slice();
        g.writeBuffer(buf, offset, data);
      },
      begin_compute_pass: (): number => g.beginComputePass(),
      compute_set_pso: (pass: number, pso: number) => g.computeSetPipeline(pass, pso),
      compute_set_texture: (pass: number, tex: number, slot: number, access: number) =>
        g.computeSetTexture(pass, tex, slot, access),
      compute_set_buffer: (pass: number, buf: number, offset: number, slot: number) =>
        g.computeSetBuffer(pass, buf, offset, slot),
      compute_dispatch: (pass: number, x: number, y: number, z: number) => g.computeDispatch(pass, x, y, z),
      end_compute_pass: (pass: number) => g.endComputePass(pass),
    };
  }
}
