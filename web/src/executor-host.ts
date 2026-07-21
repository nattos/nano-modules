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
  /** Signed delta for the executor (backward scrub → effect seek). Falls back to
   *  `deltaTime` when absent. */
  execDeltaTime?: number;
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
  /** Optional: push the absolute transport time (s) before execute (effect seeks). */
  executor_set_time?(ex: number, sec: number): void;
  executor_set_automation(ex: number, json: number, len: number): void;
  executor_set_external_scalars(ex: number, json: number, len: number): void;
  executor_debug_stats(ex: number, out: number): void;
  executor_modulation_json(ex: number, out: number, cap: number): number;
  executor_set_bus_tag(ex: number, tag: number, len: number): void;
  /** Module-level (the sidechannel bus is process-global across slots). */
  executor_sidechannels_version(): number;
  executor_sidechannels_json(out: number, cap: number): number;
  executor_scalar_sidechannels_json(out: number, cap: number): number;
  executor_sidechannel_texture(name: number, len: number): number;
  /** Module-level (the trigger bus is process-global across slots). */
  executor_triggers_version?(): number;
  executor_triggers_json?(out: number, cap: number): number;
  // ── Composition executor (comp_api.cpp) ──
  comp_create(): number;
  comp_destroy(c: number): void;
  comp_sketch_executor(c: number): number;
  comp_register_schema(c: number, mt: number, mtLen: number, fields: number, len: number): void;
  comp_register_capabilities(c: number, mt: number, mtLen: number, caps: number, len: number): void;
  comp_load_document(c: number, json: number, len: number): void;
  comp_doc_epoch(c: number): number;
  comp_set_device_param(c: number, owner: number, ownerLen: number, dev: number, devLen: number,
                        field: number, fieldLen: number, value: number, valueLen: number): void;
  comp_set_track_level(c: number, track: number, trackLen: number, level: number): void;
  comp_set_lane_points(c: number, owner: number, ownerLen: number, lane: number, laneLen: number,
                       xyBend: number, nPoints: number): void;
  comp_set_rail_base(c: number, track: number, trackLen: number, xyBend: number, nPoints: number): void;
  comp_set_source_transform(c: number, clip: number, clipLen: number, json: number, jsonLen: number): void;
  comp_play(c: number): void;
  comp_pause(c: number): void;
  comp_seek_beat(c: number, beat: number): void;
  comp_set_loop(c: number, enabled: number, startBeat: number, endBeat: number): void;
  comp_set_transport_mode(c: number, precise: number): void;
  comp_set_clip_auto_timing(c: number, loopMode: number): void;
  comp_set_ignore_solo(c: number, on: number): void;
  comp_position_beat(c: number): number;
  comp_position_sec(c: number): number;
  comp_bpm(c: number): number;
  comp_set_video_ready(c: number, clipId: number, len: number, ready: number): void;
  comp_update(c: number, dtSec: number): number;
  comp_render(c: number, inTex: number, outTex: number, w: number, h: number, dt: number): number;
  comp_required_json(c: number, out: number, cap: number): number;
  comp_chain_keys_json(c: number, out: number, cap: number): number;
  comp_video_descs_json(c: number, out: number, cap: number): number;
  comp_layer_targets_json(c: number, out: number, cap: number): number;
  comp_launch_scene(c: number, track: number, trackLen: number, scene: number, sceneLen: number): void;
  comp_stop_scene(c: number, track: number, len: number): void;
  comp_stop_all_scenes(c: number): void;
  comp_scene_states_json(c: number, out: number, cap: number): number;
  comp_reset_executor(c: number): void;
}

// Per-sketch executor C++ instance: separate intermediate pool / delayed-wire
// state / fused-PSO cache / schema set, so concurrent sketches don't collide.
interface SketchSlot {
  exPtr: number;
  /** Last-seen per-sketch structural revision (engine-worker touchSketch).
   *  undefined on a fresh slot ⇒ the first frame is dirty. Replaces the old
   *  whole-sketch JSON.stringify compare that ran every frame. */
  lastRev?: number;
  registeredSchemas: Set<string>;
  outputTex: number;   // GPUHost handle of the RGBA8 destination texture
  outW: number;
  outH: number;
  /** Instance keys this executor has ever applied state for (mirrors its native
   *  `lastAppliedState_`). If a key here is recreated as a FRESH web instance
   *  (after a prune), the native state cache is stale → rebuild the slot. */
  appliedKeys: Set<string>;
  /** The sketch's working format code (1 = RGBA8, 3 = RGBA16F) this slot's
   *  instances were built under. A bitDepth change rebuilds the slot AND its
   *  chain's WasmHosts so per-format WGSL (storage decls) retranslates. */
  fmtCode: number;
  /** True once a non-empty sketch doc reached executor_execute — the guard
   *  for the clean-frame sketch_len=0 fast path (cache seeded C++-side). */
  execSentOnce: boolean;
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
  /** Per-key create-failure backoff (see ensureInstance) — a key here is
   *  skipped (renders as passthrough) until its retry deadline passes. */
  private createFailures = new Map<string, { until: number; backoffMs: number }>();
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
  /** Last external-scalar table (setExternalScalars), re-applied to new slots. */
  private externalScalarsJson = '';

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
    // Failed create (most commonly WebAssembly OOM — Chrome caps live wasm
    // memories at ~100/process, so a huge chain can exhaust the budget):
    // back off instead of re-attempting every frame. The per-frame retry
    // loop instantiated + threw + GC'd continuously, collapsing the whole
    // engine to <20 fps; with the backoff the sketch renders WITHOUT the
    // failed entries (passthrough) and retries occasionally.
    const failed = this.createFailures.get(key);
    if (failed && performance.now() < failed.until) return null;
    // Dedup concurrent creates: WASM instantiation is async (>1 frame), and the
    // per-frame drive re-enters here before it finishes — return the same promise.
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const host = new WasmHost();
        host.bridgeCore = this.bridgeCore;
        host.gpuHost = this.gpuHost;
        host.onSchemaChanged = this.onHostSchemaChanged;
        await host.load(found.compiled);
        const module = host.activateEffect(found.resolvedId);
        const inst: WebEffectInstance = { host, module, moduleType: mt, resolvedId };
        this.instances.set(key, inst);
        this.createFailures.delete(key);
        return inst;
      } catch (err) {
        const backoffMs = Math.min((this.createFailures.get(key)?.backoffMs ?? 1000) * 2, 30000);
        this.createFailures.set(key, { until: performance.now() + backoffMs, backoffMs });
        console.error(
          `[executor] instance create failed (${mt} ${key}), backing off ${backoffMs}ms:`, err);
        return null;
      }
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
   * `lastRev` matching → `dirty=0` → a time-independent effect's stale instance
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
    // The comp executor's internal slot reports alongside the plain ones (its
    // handle is re-read per call — comp_reset_executor invalidates old ones).
    const exPtrs = [...this.slots.values()].map((s) => s.exPtr);
    if (this.compPtr) exPtrs.push(this.exports.comp_sketch_executor(this.compPtr));
    for (const exPtr of exPtrs) {
      if (this.modScratchCap === 0) {
        this.modScratchCap = 4096;
        this.modScratch = this.exports.malloc(this.modScratchCap);
      }
      let n = this.exports.executor_modulation_json(exPtr, this.modScratch, this.modScratchCap);
      if (n > this.modScratchCap) {
        this.exports.free(this.modScratch);
        this.modScratchCap = n + 256;
        this.modScratch = this.exports.malloc(this.modScratchCap);
        n = this.exports.executor_modulation_json(exPtr, this.modScratch, this.modScratchCap);
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
      // Seed the fresh executor with the current external-scalar table —
      // MIDI values only re-push on device events, which a slot created
      // mid-session would otherwise miss until the next knob twist.
      if (this.externalScalarsJson) {
        const esBytes = encoder.encode(this.externalScalarsJson);
        const esPtr = this.exports.malloc(esBytes.length);
        new Uint8Array(this.memory.buffer, esPtr, esBytes.length).set(esBytes);
        this.exports.executor_set_external_scalars(exPtr, esPtr, esBytes.length);
        this.exports.free(esPtr);
      }
      // Tag the executor's sidechannel-bus writes with its sketch id (the UI
      // maps it to the playground instance label for channel names).
      const tagBytes = encoder.encode(sketchId);
      const tagPtr = this.exports.malloc(tagBytes.length);
      new Uint8Array(this.memory.buffer, tagPtr, tagBytes.length).set(tagBytes);
      this.exports.executor_set_bus_tag(exPtr, tagPtr, tagBytes.length);
      this.exports.free(tagPtr);
      slot = { exPtr,
               registeredSchemas: new Set(), outputTex: 0, outW: 0, outH: 0,
               appliedKeys: new Set(), fmtCode: 1, execSentOnce: false };
      this.slots.set(sketchId, slot);
    }
    return slot;
  }

  /**
   * Sidechannel-bus channel metadata, for the worker's `sidechannels` push:
   * `version` bumps only on metadata change (new channel / writer / size —
   * NOT per write), so poll it per frame and parse the JSON only on change.
   * TEXTURE channels and SCALAR (value) channels are separate namespaces
   * sharing the one version, so both are fetched on a change.
   */
  getSidechannelInfo(): {
    version: number;
    channels: Record<string, { writer: string; w: number; h: number }>;
    scalars: Record<string, { writer: string }>;
  } | null {
    if (!this.exports.executor_sidechannels_version) return null;
    const version = this.exports.executor_sidechannels_version();
    return {
      version,
      channels: this.readBusJson(this.exports.executor_sidechannels_json),
      scalars: this.readBusJson(this.exports.executor_scalar_sidechannels_json),
    };
  }

  /** Read one of the bus's grow-and-retry JSON dumps out of wasm memory. */
  private readBusJson(dump?: (out: number, cap: number) => number): any {
    if (!dump) return {};
    let cap = 4096;
    let ptr = this.exports.malloc(cap);
    let n = dump(ptr, cap);
    if (n > cap) {
      this.exports.free(ptr);
      cap = n;
      ptr = this.exports.malloc(cap);
      n = dump(ptr, cap);
    }
    const json = decoder.decode(new Uint8Array(this.memory.buffer, ptr, n));
    this.exports.free(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  /**
   * Trigger-bus rail/channel activity, for the worker's `triggerRails` push:
   * `version` bumps only on metadata change (a rail/channel/writer first seen —
   * NOT per event), so poll it per frame and parse the JSON only on change.
   * Shape: `{ "<rail>": { "<channel>": {on, velocity, writer, seq[, precision]} } }`
   * (precision only for a strict channel).
   */
  getTriggerRailInfo(): { version: number; rails: Record<string, Record<string, { on: boolean; velocity: number; writer: string; seq: number; precision?: { mode: 'strict'; deadline: number } }>> } | null {
    if (!this.exports.executor_triggers_version || !this.exports.executor_triggers_json) return null;
    const version = this.exports.executor_triggers_version();
    let cap = 4096;
    let ptr = this.exports.malloc(cap);
    let n = this.exports.executor_triggers_json(ptr, cap);
    if (n > cap) {
      this.exports.free(ptr);
      cap = n;
      ptr = this.exports.malloc(cap);
      n = this.exports.executor_triggers_json(ptr, cap);
    }
    const json = decoder.decode(new Uint8Array(this.memory.buffer, ptr, n));
    this.exports.free(ptr);
    try {
      return { version, rails: JSON.parse(json) };
    } catch {
      return { version, rails: {} };
    }
  }

  /**
   * The bus-owned texture handle currently carrying `channel` (last-written
   * content, no freshness semantics), or -1. For the worker's sidechannel
   * thumbnail traces — the handle resolves in the shared GPUHost table.
   */
  getSidechannelTexture(channel: string): number {
    if (!this.exports.executor_sidechannel_texture) return -1;
    const bytes = encoder.encode(channel);
    if (bytes.length === 0) return -1;
    const ptr = this.exports.malloc(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    const handle = this.exports.executor_sidechannel_texture(ptr, bytes.length);
    this.exports.free(ptr);
    return handle;
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

  /** Push the external scalar table (MIDI device control values,
   *  `{"midi:<uuid>": {"b0/e05/turn": 0.42}}`) to every live slot. Wires from
   *  out-of-chain `midi:` sources fold these through the normal read-tap
   *  pipeline; wires whose value is absent stay dormant. Unlike automation
   *  this changes on MIDI events (not per frame), so the last table is
   *  remembered and re-applied to slots created later. Empty object clears. */
  setExternalScalars(json: string): void {
    this.externalScalarsJson = json;
    const bytes = encoder.encode(json);
    const ptr = this.exports.malloc(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    for (const slot of this.slots.values()) {
      this.exports.executor_set_external_scalars(slot.exPtr, ptr, bytes.length);
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
    sketchId: string, sketch: Sketch,
    /** Per-sketch structural revision from the caller (who owns every mutation
     *  site). A changed rev = dirty frame (plan rebuild + full state apply). */
    sketchRev: number, inputHandle: number,
    frameState: FrameState, width: number, height: number,
    /** Called once this frame's instances are ensured (created/revived) but BEFORE the
     *  native drive — so the host can (re)bind per-instance input textures onto the
     *  fresh instances, else a just-created instance renders with unbound slots. */
    onInstancesReady?: () => void): Promise<number> {
    this.currentSketchId = sketchId;
    let slot = this.slotFor(sketchId);
    const chain = sketchChain(sketch);

    // Per-sketch working format (outputFormat.bitDepth). Set on the GPU host
    // BEFORE instance pre-creation so init-time texture/PSO/WGSL creation
    // resolves TextureFormat::SketchDefault correctly. A change rebuilds the
    // slot and the chain's WasmHosts — their translated WGSL storage decls
    // and pipelines baked the previous format.
    const fmtCode = (sketch as { outputFormat?: { bitDepth?: number } })
        .outputFormat?.bitDepth === 16 ? 3 : 1;
    if (slot.fmtCode !== fmtCode) {
      this.destroySlot(slot);
      this.slots.delete(sketchId);
      for (const e of chain) {
        if (e.type === 'module') this.instances.delete(e.instance_key);
      }
      slot = this.slotFor(sketchId);
      slot.fmtCode = fmtCode;
    }
    this.gpuHost.setDefaultFormatCode(fmtCode);

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

    // 3. (Removed) Live published OUTPUT scalars are no longer mirrored into
    //    the sketch doc: captureWriteTaps reads them straight from the
    //    producer's published state (its barrel-path fallback), so the doc
    //    stays purely structural. That's what lets the executor cache the
    //    lowered exec doc across clean frames — a per-frame mirror both
    //    defeated the cache and froze wire values at the last dirty frame.
    const execSketch = sketch;

    // 4. Dirty = the caller-owned structural revision moved (engine-worker
    //    bumps it at every sketch mutation site). Replaces the old per-frame
    //    JSON.stringify(sketch) compare — steady-state frames now do ZERO
    //    sketch serialization.
    const dirty = slot.lastRev !== sketchRev;
    slot.lastRev = sketchRev;
    // On a dirty frame the native executor (re)applies state for every chain
    // entry — remember those keys so we can detect a later prune+revive.
    if (dirty) for (const e of chain) if (e.type === 'module') slot.appliedKeys.add(e.instance_key);
    const outTex = this.ensureOutputTexture(slot, width, height);

    // Clean-frame fast path: the executor caches its lowered exec doc across
    // clean frames, so once a dirty frame has delivered this sketch there is
    // nothing to marshal — sketch_len 0 skips the encode → copy → wasm-side
    // JSON parse round-trip (the dominant per-frame cost for long chains).
    // `execSentOnce` guards the very first frame (cache not seeded yet).
    const sendDoc = dirty || !slot.execSentOnce;
    let jptr = 0, jlen = 0;
    if (sendDoc) {
      const jbytes = encoder.encode(JSON.stringify(sketch));
      jlen = jbytes.length;
      jptr = this.exports.malloc(jlen);
      new Uint8Array(this.memory.buffer, jptr, jlen).set(jbytes);
    }
    let outHandle = inputHandle;
    try {
      // Push the absolute transport time so the executor can seek effects on a backward
      // jump OR a clip activation (to clip-relative time). Optional export — guard it.
      this.exports.executor_set_time?.(slot.exPtr, frameState.elapsedTime);
      outHandle = this.exports.executor_execute(
        slot.exPtr, jptr, jlen, inputHandle, outTex,
        // Signed delta: a backward scrub seeks seekable effects instead of freezing.
        width, height, frameState.execDeltaTime ?? frameState.deltaTime, dirty ? 1 : 0);
      if (sendDoc) slot.execSentOnce = true;
    } finally {
      if (jptr) this.exports.free(jptr);
    }
    this.accumulateDebugStats(slot.exPtr);

    // Fire each effect's `on_state_ready` hook ONCE, now that the executor has
    // applied this instance's initial state. It's the post-load hook effects use
    // to set their initial inspector field visibility (e.g. warp.crop hides the
    // inactive mode's fields via setFieldHidden). Without it that visibility was
    // only ever applied on a LATER state patch — so a freshly-loaded clip showed
    // the wrong fields until you nudged a value. `fireStateReady` is idempotent
    // per host (stateReadyFired guard), so calling it every frame is a cheap
    // no-op after the first.
    for (const entry of chain) {
      if (entry.type === 'module') this.instances.get(entry.instance_key)?.host.fireStateReady();
    }
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

  // ══════════════════════════════════════════════════════════════════════
  // Composition executor (comp mode) — the arrangement compositor running
  // IN-WASM (comp_* ABI). The worker toggles it on via compEnable and drives
  // compFrame once per tick; edits/transport arrive as comp* calls. Mirrors
  // executeAllColumns' async-instance seam: comp_update never touches effrt,
  // instances are ensured host-side, then comp_render drives synchronously.
  // ══════════════════════════════════════════════════════════════════════

  private compPtr = 0;
  private compScratch = 0;
  private compScratchCap = 0;
  private compRequired: Array<{ moduleType: string; instanceKey: string }> = [];
  /** Chain instance keys the comp executor currently needs — the worker's
   *  pruneInstancesExcept must union these or comp instances churn every frame. */
  readonly compRequiredKeys = new Set<string>();
  /** Keys the comp's internal executor has applied state for (revive guard). */
  private compAppliedKeys = new Set<string>();
  /** Keys whose instance creation failed (warn once until it succeeds). */
  private compEnsureWarned = new Set<string>();
  private compOutTex = 0;
  private compOutW = 0;
  private compOutH = 0;
  /** Comp positionSec at the END of the last compFrame — the effect-clock anchor
   *  (see compFrame). Null until the first frame. */
  private compPrevSec: number | null = null;

  get compActive(): boolean { return this.compPtr !== 0; }

  private ensureComp(): number {
    if (!this.compPtr) this.compPtr = this.exports.comp_create();
    return this.compPtr;
  }

  /** Marshal a string into wasm memory around `fn` (malloc/copy/free). */
  private withBytes<T>(s: string, fn: (ptr: number, len: number) => T): T {
    const bytes = encoder.encode(s);
    const ptr = this.exports.malloc(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    try { return fn(ptr, bytes.length); } finally { this.exports.free(ptr); }
  }

  /** Grow-and-retry readback into the persistent comp scratch buffer. */
  private compRead(call: (out: number, cap: number) => number): string {
    if (!this.compScratchCap) {
      this.compScratchCap = 4096;
      this.compScratch = this.exports.malloc(this.compScratchCap);
    }
    let n = call(this.compScratch, this.compScratchCap);
    if (n > this.compScratchCap) {
      this.exports.free(this.compScratch);
      this.compScratchCap = n + 1024;
      this.compScratch = this.exports.malloc(this.compScratchCap);
      n = call(this.compScratch, this.compScratchCap);
    }
    return n > 0 ? this.readString(this.compScratch, n) : '';
  }

  compEnable(): void { this.ensureComp(); }

  /** Seed one module's schema + capabilities into the comp catalog (idempotent
   *  per type; the worker feeds every discovered plugin). */
  compRegisterSchema(moduleType: string, fieldsJson: string, capsJson: string): void {
    const c = this.ensureComp();
    this.withBytes(moduleType, (mp, ml) =>
      this.withBytes(fieldsJson, (sp, sl) => this.exports.comp_register_schema(c, mp, ml, sp, sl)));
    this.withBytes(moduleType, (mp, ml) =>
      this.withBytes(capsJson, (cp, cl) => this.exports.comp_register_capabilities(c, mp, ml, cp, cl)));
  }

  compLoadDocument(json: string): void {
    const c = this.ensureComp();
    this.withBytes(json, (p, l) => this.exports.comp_load_document(c, p, l));
  }

  /** The last compControl `seq` applied — echoed on every compFrame report so
   *  the bridge's playhead mirror-back can suppress pre-seek echoes exactly. */
  private compControlSeq = 0;

  compControl(msg: { op: string; beat?: number; enabled?: boolean; startBeat?: number;
                     endBeat?: number; precise?: boolean; loopMode?: boolean; on?: boolean;
                     clipId?: string; ready?: boolean; seq?: number }): void {
    const c = this.ensureComp();
    if (msg.seq != null) this.compControlSeq = msg.seq;
    switch (msg.op) {
      case 'play': this.exports.comp_play(c); break;
      case 'pause': this.exports.comp_pause(c); break;
      case 'seek': this.exports.comp_seek_beat(c, msg.beat ?? 0); break;
      case 'loop':
        this.exports.comp_set_loop(c, msg.enabled ? 1 : 0, msg.startBeat ?? 0, msg.endBeat ?? 0);
        break;
      case 'mode': this.exports.comp_set_transport_mode(c, msg.precise ? 1 : 0); break;
      case 'clipTiming': this.exports.comp_set_clip_auto_timing(c, msg.loopMode ? 1 : 0); break;
      case 'ignoreSolo': this.exports.comp_set_ignore_solo(c, msg.on ? 1 : 0); break;
      case 'videoReady':
        this.withBytes(msg.clipId ?? '', (p, l) =>
          this.exports.comp_set_video_ready(c, p, l, msg.ready ? 1 : 0));
        break;
    }
  }

  compOp(msg: { op: string; ownerId?: string; deviceId?: string; field?: string;
                valueJson?: string; trackId?: string; level?: number; laneId?: string;
                points?: number[]; sceneId?: string }): void {
    const c = this.ensureComp();
    switch (msg.op) {
      case 'param':
        this.withBytes(msg.ownerId ?? '', (op_, ol) =>
          this.withBytes(msg.deviceId ?? '', (dp, dl) =>
            this.withBytes(msg.field ?? '', (fp, fl) =>
              this.withBytes(msg.valueJson ?? 'null', (vp, vl) =>
                this.exports.comp_set_device_param(c, op_, ol, dp, dl, fp, fl, vp, vl)))));
        break;
      case 'trackLevel':
        this.withBytes(msg.trackId ?? '', (p, l) =>
          this.exports.comp_set_track_level(c, p, l, msg.level ?? 1));
        break;
      case 'lanePoints': {
        const pts = msg.points ?? [];
        const ptr = this.exports.malloc(pts.length * 8);
        new Float64Array(this.memory.buffer, ptr, pts.length).set(pts);
        this.withBytes(msg.ownerId ?? '', (op_, ol) =>
          this.withBytes(msg.laneId ?? '', (lp, ll) =>
            this.exports.comp_set_lane_points(c, op_, ol, lp, ll, ptr, pts.length / 3)));
        this.exports.free(ptr);
        break;
      }
      case 'railBase': {
        const pts = msg.points ?? [];
        const ptr = this.exports.malloc(pts.length * 8);
        new Float64Array(this.memory.buffer, ptr, pts.length).set(pts);
        this.withBytes(msg.trackId ?? '', (p, l) =>
          this.exports.comp_set_rail_base(c, p, l, ptr, pts.length / 3));
        this.exports.free(ptr);
        break;
      }
      case 'sourceTransform':
        this.withBytes(msg.ownerId ?? '', (cp, cl) =>
          this.withBytes(msg.valueJson ?? '{}', (jp, jl) =>
            this.exports.comp_set_source_transform(c, cp, cl, jp, jl)));
        break;
      case 'launchScene':
        this.withBytes(msg.trackId ?? '', (tp, tl) =>
          this.withBytes(msg.sceneId ?? '', (sp, sl) =>
            this.exports.comp_launch_scene(c, tp, tl, sp, sl)));
        break;
      case 'stopScene':
        this.withBytes(msg.trackId ?? '', (p, l) => this.exports.comp_stop_scene(c, p, l));
        break;
      case 'stopAllScenes':
        this.exports.comp_stop_all_scenes(c);
        break;
    }
  }

  /**
   * Drive one comp frame: comp_update (advance/eval/rebuild, no effrt), then
   * ensure this frame's instances host-side (the SAME pre-await + revive seam
   * as executeAllColumns), then comp_render. Returns the output handle plus the
   * per-frame report the worker ships to the main thread.
   */
  async compFrame(
    dt: number, frameState: FrameState, width: number, height: number,
    onInstancesReady?: () => void,
  ): Promise<{ handle: number; hasContent: boolean; structureChanged: boolean;
               holding: boolean; positionBeat: number; positionSec: number;
               chainKeys?: string[]; videoDescs?: string; layerTargets?: string;
               scenes?: string; controlSeq: number }> {
    const c = this.ensureComp();
    // The effect clock advances by the COMP transport's motion, not wall time:
    // paused → 0 (static frame), scrub → a signed jump (executor effect seeks).
    // prevSec persists ACROSS frames (not read fresh here): a seek lands between
    // ticks, so a fresh read would absorb the jump and effects would never seek.
    // The paused-seek stepper (offline export, scrubbing) depends on this.
    const prevSec = this.compPrevSec ?? this.exports.comp_position_sec(c);
    const flags = this.exports.comp_update(c, dt);
    const structureChanged = !!(flags & 1);
    const hasContent = !!(flags & 2);
    const holding = !!(flags & 4);
    const videoSetChanged = !!(flags & 8);
    const scenesChanged = !!(flags & 16);

    let chainKeys: string[] | undefined;
    let layerTargets: string | undefined;
    if (structureChanged) {
      // The build's `__layer__` resolution (ownerId → {instanceKey, field}) —
      // shipped alongside chainKeys so UI modulation bands survive the
      // per-clip blend-key churn.
      layerTargets =
          this.compRead((o, n) => this.exports.comp_layer_targets_json(c, o, n)) || '{}';
      const reqJson = this.compRead((o, n) => this.exports.comp_required_json(c, o, n));
      this.compRequired = reqJson ? JSON.parse(reqJson) : [];
      this.compRequiredKeys.clear();
      for (const r of this.compRequired) this.compRequiredKeys.add(r.instanceKey);
      // Revive guard (the plain path's slot rebuild): a required key whose web
      // instance is GONE (pruned) but whose state the comp's internal executor
      // already applied would render with DEFAULT params — rebuild the internal
      // executor so all state re-applies from scratch.
      const reviving = this.compRequired.some((r) =>
        !this.instances.has(r.instanceKey) && !this.inflight.has(r.instanceKey) &&
        this.compAppliedKeys.has(r.instanceKey));
      if (reviving) {
        this.exports.comp_reset_executor(c);
        this.compAppliedKeys.clear();
      }
      for (const r of this.compRequired) this.compAppliedKeys.add(r.instanceKey);
      const keysJson = this.compRead((o, n) => this.exports.comp_chain_keys_json(c, o, n));
      chainKeys = keysJson ? JSON.parse(keysJson) : [];
    }

    // Ensure every chain entry's instance + thread the frame state onto its
    // host (effrt tick/render read host.frameState) — executeAllColumns step 1.
    // Per-instance failures (e.g. a WebAssembly OOM) DEGRADE, never abort: the
    // frame renders without that entry (transparent layer), transport +
    // mirror-back keep flowing, and the next frame retries. One bad instance
    // killing the whole comp frame blacked out the entire arrangement.
    for (const r of this.compRequired) {
      let inst: WebEffectInstance | null = null;
      try {
        inst = await this.ensureInstance(r.moduleType, r.instanceKey);
      } catch (err) {
        if (!this.compEnsureWarned.has(r.instanceKey)) {
          this.compEnsureWarned.add(r.instanceKey);
          console.error(`[comp] instance create failed (skipping) ${r.moduleType} ${r.instanceKey}:`, err);
        }
        continue;
      }
      if (!inst) continue;
      this.compEnsureWarned.delete(r.instanceKey);
      const fs = inst.host.frameState;
      fs.elapsedTime = frameState.elapsedTime;
      fs.deltaTime = frameState.deltaTime;
      // Comp mode owns the musical clock: barPhase from the REAL transport
      // beat (4 beats/bar; exact even under warp) + the composition's tempo —
      // the worker's frameState carries a wall-clock 120 BPM stand-in that
      // would make beat-reactive effects (mod.trigger.beat) tick off-grid.
      const compBeat = this.exports.comp_position_beat(c);
      fs.barPhase = ((compBeat / 4) % 1 + 1) % 1;
      fs.bpm = this.exports.comp_bpm(c);
      fs.viewportW = width;
      fs.viewportH = height;
    }
    onInstancesReady?.();

    // Frame-local effrt handle table (repopulated by effrt_instance_for).
    this.byHandle = [];
    this.handleByKey.clear();

    if (!this.compOutTex || this.compOutW !== width || this.compOutH !== height) {
      if (this.compOutTex) this.gpuHost.release(this.compOutTex);
      this.compOutTex = this.gpuHost.createTexture(width, height, /*RGBA8*/ 1);
      this.compOutW = width;
      this.compOutH = height;
    }

    this.currentSketchId = 'arr-composite';
    const nowSec = this.exports.comp_position_sec(c);
    const execDt = nowSec - prevSec;
    this.compPrevSec = nowSec;
    const handle = this.exports.comp_render(c, -1, this.compOutTex, width, height, execDt);
    this.accumulateDebugStats(this.exports.comp_sketch_executor(c));

    const out: { handle: number; hasContent: boolean; structureChanged: boolean;
                 holding: boolean; positionBeat: number; positionSec: number;
                 chainKeys?: string[]; videoDescs?: string; layerTargets?: string;
                 scenes?: string; controlSeq: number } = {
      handle, hasContent, structureChanged, holding,
      positionBeat: this.exports.comp_position_beat(c),
      positionSec: this.exports.comp_position_sec(c),
      controlSeq: this.compControlSeq,
    };
    if (chainKeys) out.chainKeys = chainKeys;
    if (layerTargets !== undefined) out.layerTargets = layerTargets;
    if (videoSetChanged) {
      out.videoDescs = this.compRead((o, n) => this.exports.comp_video_descs_json(c, o, n));
    }
    if (scenesChanged) {
      out.scenes =
          this.compRead((o, n) => this.exports.comp_scene_states_json(c, o, n)) || '{}';
    }
    return out;
  }

  // ---- effrt host imports (mirror native/src/sketch/effrt_impls.cpp) ----
  private resolve(h: number): WebEffectInstance | null {
    return (h >= 0 && h < this.byHandle.length) ? this.byHandle[h] : null;
  }

  private buildEffrtImports(): WebAssembly.ModuleImports {
    return {
      instance_for: (mtPtr: number, mtLen: number, keyPtr: number, keyLen: number): number => {
        const raw = this.readString(keyPtr, keyLen);
        // The executor prefixes instance keys with "f16!" when the sketch's
        // working format is 16F (its per-format instance-namespace mechanism —
        // see nsPrefix_ in sketch_executor.cpp). On web, format freshness is
        // handled by the slot/WasmHost rebuild in executeAllColumns, and
        // this.instances is keyed by bare instance_key — strip the prefix.
        const key = raw.startsWith('f16!') ? raw.slice(4) : raw;
        const inst = this.instances.get(key);
        if (!inst) return -1;
        const cached = this.handleByKey.get(raw);
        if (cached !== undefined) return cached;
        const h = this.byHandle.length;
        this.byHandle.push(inst);
        this.handleByKey.set(raw, h);
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
      // Numeric fast path: one published scalar, NO JSON — the per-frame wire
      // path (captureWriteTaps). Writes the f64 at `outPtr`, returns 1/0.
      published_scalar: (h: number, fieldPtr: number, fieldLen: number, outPtr: number): number => {
        const i = this.resolve(h);
        const ps = i?.host.pluginState;
        if (!ps || typeof ps !== 'object') return 0;
        const v = (ps as Record<string, unknown>)[this.readString(fieldPtr, fieldLen)];
        const num = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null;
        if (num === null) return 0;
        new DataView(this.memory.buffer).setFloat64(outPtr, num, true);
        return 1;
      },
      // Numeric trigger-ring read (mirror effrt_read_triggers): 5 doubles per
      // event — seq, on(0/1), channel(NaN=unpublished), velocity(default 1),
      // deadline_ms(0=any; >0=strict; strict-no-deadline→100). Returns the
      // event count; -1 when no ring is published (empty-ring vs no-ring
      // drives the callers' seq-watermark baselining — see effrt.h).
      read_triggers: (h: number, outPtr: number, cap: number): number => {
        const ring = (this.resolve(h)?.host.pluginState as
            { triggers?: unknown } | undefined)?.triggers;
        if (!Array.isArray(ring) || cap <= 0) return -1;
        const n = Math.min(ring.length, cap);
        const out = new Float64Array(this.memory.buffer, outPtr, n * 5);
        for (let k = 0; k < n; k++) {
          const e = (ring[k] ?? {}) as Record<string, unknown>;
          out[k * 5] = typeof e.seq === 'number' ? e.seq : 0;
          out[k * 5 + 1] = e.on === true ? 1 : 0;
          out[k * 5 + 2] = typeof e.channel === 'number' ? e.channel : NaN;
          out[k * 5 + 3] = typeof e.velocity === 'number' ? e.velocity : 1;
          const p = e.precision as { mode?: unknown; deadline?: unknown } | undefined;
          out[k * 5 + 4] = p?.mode === 'strict'
              ? (typeof p.deadline === 'number' && p.deadline > 0 ? p.deadline : 100)
              : 0;
        }
        return n;
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
      build_fused_source: (instsPtr: number, count: number, out: number, cap: number,
                           outFmt: number): number => {
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
        // The executor passes the group output's TextureFormat code (the
        // sketch's working format) — bake the matching WGSL storage format
        // into the generated kernel (16F sketches write rgba16float
        // intermediates).
        const outputFormat = outFmt === 3 ? 'rgba16float' : 'rgba8unorm';
        // composeWgsl emits `fn main`; the executor builds the PSO with entry
        // "fused_main" (gpu_create_compute_pso) — rename to match.
        const src = composeWgsl(stages, [], outputFormat).replace(
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
      // The sketch working format (what TextureFormat::SketchDefault resolves
      // to). The executor sets it once per execute() from outputFormat.bitDepth;
      // executeAllColumns pre-seeds the same value before instance creation.
      set_default_texture_format: (code: number) => g.setDefaultFormatCode(code),
      // Live backend code (1 = WebGPU here). The executor's wet/dry blend picks
      // WGSL vs MSL from this — without it the blend would feed MSL to WebGPU.
      get_backend: (): number => g.getBackend(),
      // The executor batches the whole frame between begin/end_submit_batch.
      // While the batch is open, effect-called gpu::Device::submit() is a
      // no-op (matching native); the one real flush happens at endBatch.
      begin_submit_batch: () => g.beginBatch(),
      end_submit_batch: () => g.endBatch(),
      create_shader_module: (srcPtr: number, srcLen: number): number =>
        g.createShaderModule(this.readString(srcPtr, srcLen)),
      create_compute_pso: (shader: number, entryPtr: number, entryLen: number): number =>
        g.createComputePipelineAuto(shader, this.readString(entryPtr, entryLen)),
      // exec_gpu.h create_buffer carries an i64 size → BigInt here.
      create_buffer: (size: bigint, usage: number): number =>
        g.createBuffer(Number(size), usage),
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
