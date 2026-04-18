/**
 * Sketch executor — walks chains of virtual module instances,
 * piping textures and data between modules via sideband rails.
 */

import type { BridgeCore } from './bridge-core';
import type { GPUHost } from './gpu-host';
import { WasmHost, WasmModule, FrameState } from './wasm-host';
import type { ChainEntry, ModuleEntry, Sketch, SketchColumn, Rail, Tap } from './sketch-types';

interface LoadedModule {
  host: WasmHost;
  module: WasmModule;
}

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
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

  /**
   * Per-chain-entry texture handles from the most recent frame.
   * Keyed by `${sketchId}/${colIdx}/${chainIdx}`.
   * Populated during executeColumn(), consumed by engine-worker for chain_entry trace points.
   */
  public chainEntryHandles = new Map<string, { input: number; output: number }>();

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

  constructor(
    bridgeCore: BridgeCore, gpuHost: GPUHost, device: GPUDevice, format: GPUTextureFormat,
    findModule: (effectId: string) => { compiled: WebAssembly.Module; resolvedId: string } | null,
  ) {
    this.bridgeCore = bridgeCore;
    this.gpuHost = gpuHost;
    this.device = device;
    this.format = format;
    this.findModule = findModule;
  }

  async ensureInstance(entry: ModuleEntry): Promise<LoadedModule> {
    // Resolve the module type early so identity comparisons are stable even
    // when entry.module_type is a fully-qualified bundle ID (e.g.
    // "com.nattos.nano_effects.data.particles_emitter") whose registered
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

    if (!found) {
      throw new Error(`Module "${entry.module_type}" not registered. Load the containing bundle first.`);
    }
    await host.load(found.compiled);
    const mod = host.activateEffect(found.resolvedId);
    loaded = { host, module: mod };

    this.instances.set(entry.instance_key, loaded);
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
    const texUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
                   | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;

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

    let lastOutput = inputTextureHandle;
    for (let colIdx = 0; colIdx < sketch.columns.length; colIdx++) {
      const column = sketch.columns[colIdx];
      const colRails = new Map<string, RailValue>();
      const colOutput = await this.executeColumn(
        sketchId, sketch, colIdx, inputTextureHandle,
        frameState, width, height, crossRailValues, slotCounter, colRails);
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

    for (let chainIdx = 0; chainIdx < column.chain.length; chainIdx++) {
      const entry = column.chain[chainIdx];
      if (entry.type === 'texture_input') {
        continue;
      }

      if (entry.type === 'texture_output') {
        break;
      }

      if (entry.type === 'module') {
        const loaded = await this.ensureInstance(entry);

        // --- Apply initial state from sketch instances (or legacy entry.params) ---
        const instanceState = sketch.instances?.[entry.instance_key]?.state ?? entry.params ?? {};
        const paramPatches: import('./wasm-host').PatchOp[] = [];
        let paramIndex = 0;
        for (const [key, value] of Object.entries(instanceState)) {
          if (typeof value === 'number') {
            // Set frameState.params by position for legacy host::param(index) reads
            loaded.host.frameState.params[paramIndex] = value;
            paramPatches.push({ op: 'replace', path: key, value });
            paramIndex++;
          } else if (Array.isArray(value)
                     && value.every(v => typeof v === 'number')) {
            // Vec2/3/4 (and other plain numeric arrays): deliver as a
            // patch but skip frameState.params (which is positional float).
            paramPatches.push({ op: 'replace', path: key, value });
          }
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
              if (typeof patch.value === 'number') {
                const vh = bc.valNumber(patch.value as number);
                bc.commitVal(pk, patch.path, vh);
                bc.valRelease(vh);
              } else if (Array.isArray(patch.value)
                         && patch.value.every(v => typeof v === 'number')) {
                const arr = bc.valArray();
                for (const item of patch.value) {
                  const itemH = bc.valNumber(item);
                  bc.valPush(arr, itemH);
                  bc.valRelease(itemH);
                }
                bc.commitVal(pk, patch.path, arr);
                bc.valRelease(arr);
              }
            }
            // Pull the committed state back into host.pluginState so the UI
            // (which reads live pluginStates broadcast each frame) reflects
            // user edits instead of stale schema defaults.
            loaded.host.pluginState = bc.getPluginState(pk);
          }
        }

        // --- Reset inactive struct inputs (before read taps run) ---
        // Without this, a module that previously received data via a tap
        // keeps its cached scalar state and GPU buffer handle forever.
        // Deleting the tap should make the input appear empty / zeroed.
        this.resetInactiveStructInputs(loaded.host, loaded.module, entry);

        // --- Apply read taps (before tick/render) ---
        const inputTextures: number[] = currentInputHandle >= 0 ? [currentInputHandle] : [];

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
              // Data tap read: push modulated value directly to the module
              loaded.host.notifyStatePatched(loaded.module, [
                { op: 'replace', path: tap.fieldPath, value: rv.data },
              ]);
            } else if (rail?.dataType === 'texture' && rv.texture !== undefined) {
              // Texture tap read: add to input texture handles
              const texIndex = parseInt(tap.fieldPath, 10);
              if (!isNaN(texIndex)) {
                while (inputTextures.length <= texIndex) inputTextures.push(-1);
                inputTextures[texIndex] = rv.texture;
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

        loaded.host.inputTextureHandles = inputTextures;

        // --- Populate textureFields for unified texture access ---
        loaded.host.textureFields.clear();
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
        const outputHandle = intermediates.handles[slotCounter.value];
        const outputTex = intermediates.textures[slotCounter.value];
        this.gpuHost.setSurface(outputTex, width, height);
        loaded.host.textureFields.set('tex_out', outputHandle);

        // --- Tick and render ---
        loaded.host.drawList = [];
        loaded.module.tick(frameState.deltaTime);
        loaded.module.render(width, height);

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
                existing.data = value;
                targetRailValues.set(tap.railId, existing);
              }
            } else if (rail?.dataType === 'texture') {
              // Texture tap write: the module's output texture goes onto the rail
              const existing = targetRailValues.get(tap.railId) ?? {};
              existing.texture = outputHandle;
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
        this.chainEntryHandles.set(`${sketchId}/${colIdx}/${chainIdx}`, {
          input: currentInputHandle,
          output: outputHandle,
        });

        // --- Advance chain ---
        currentInputHandle = outputHandle;
        slotCounter.value++;
      }
    }

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
