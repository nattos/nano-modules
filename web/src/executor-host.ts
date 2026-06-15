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
 *     to web effect instances (one WasmHost + WasmModule per chain entry, exactly
 *     like sketch-executor.ts builds today).
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
  executor_execute(ex: number, sketch: number, sketchLen: number,
                   inTex: number, outTex: number, w: number, h: number,
                   dt: number, dirty: number): number;
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
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class WasmSketchExecutor {
  private exports!: ExecutorExports;
  private get memory(): WebAssembly.Memory { return this.exports.memory; }

  // Effect instances, keyed by chain-entry instance_key (stable across frames).
  private instances = new Map<string, WebEffectInstance>();
  // Frame-local handle table the effrt imports resolve against. Cleared each
  // executeAllColumns; effrt_instance_for assigns indices as the executor asks.
  private byHandle: WebEffectInstance[] = [];
  private handleByKey = new Map<string, number>();

  private slots = new Map<string, SketchSlot>();

  // Parity with SketchExecutor's editor-support surface (inert under the flag).
  chainEntryHandles = new Map<string, { input: number; output: number }>();
  tracedChainEntries = new Set<string>();

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
      const currentId = existing.host.metadata?.id ?? '';
      if (currentId === resolvedId || currentId === mt) return existing;
      this.instances.delete(key);  // module type changed (smart-input) — rebuild
    }
    if (!found) return null;
    const host = new WasmHost();
    host.bridgeCore = this.bridgeCore;
    host.gpuHost = this.gpuHost;
    await host.load(found.compiled);
    const module = host.activateEffect(found.resolvedId);
    const inst: WebEffectInstance = { host, module, moduleType: mt, resolvedId };
    this.instances.set(key, inst);
    return inst;
  }

  invalidateInstance(instanceKey: string): void {
    this.instances.delete(instanceKey);
  }

  invalidateFusionCacheFor(_effectId: string): void {
    // The fused-PSO cache lives INSIDE executor.wasm (keyed by module-type
    // sequence). We can't selectively evict it from here, so on an HMR reload of
    // an effect we drop the live instances (invalidateInstance, called by the
    // worker) and recreate the whole executor so its caches reset cleanly.
    for (const slot of this.slots.values()) {
      this.exports.executor_destroy(slot.exPtr);
    }
    this.slots.clear();
  }

  // Stubs matching the SketchExecutor surface the worker calls (editor support,
  // inert under the flag — same as the native barrel's wasm-executor path).
  drainConsoleLogs(): any[] { return []; }
  getPluginStates(): Record<string, any> { return {}; }

  private slotFor(sketchId: string): SketchSlot {
    let slot = this.slots.get(sketchId);
    if (!slot) {
      slot = { exPtr: this.exports.executor_create(), lastJson: '',
               registeredSchemas: new Set(), outputTex: 0, outW: 0, outH: 0 };
      this.slots.set(sketchId, slot);
    }
    return slot;
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
    frameState: FrameState, width: number, height: number): Promise<number> {
    const slot = this.slotFor(sketchId);
    const chain = sketchChain(sketch);

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
        slot.registeredSchemas.add(entry.module_type);
      }
    }

    // 2. Reset the frame-local handle table (effrt_instance_for repopulates it).
    this.byHandle = [];
    this.handleByKey.clear();

    // 3. Mirror each instance's live published OUTPUT scalars (written via
    //    state::set_val during last frame's tick) into the sketch state the
    //    executor reads. Float write-taps (captureWriteTaps) source a producer's
    //    scalar from instances[key].state[field], NOT the live runtime — so a
    //    scalar wire (e.g. data.lfo.output → param) is invisible unless the
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
        if (!(((def?.io ?? 0) & 2))) continue;            // output fields only
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
    return outHandle;
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
