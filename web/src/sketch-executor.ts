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

/** Runtime value on a rail during a single frame's execution. */
interface RailValue {
  data?: number;
  texture?: number;  // GPU texture handle
}

export class SketchExecutor {
  private bridgeCore: BridgeCore;
  private gpuHost: GPUHost;
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private findModule: (effectId: string) => WebAssembly.Module | null;

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
    findModule: (effectId: string) => WebAssembly.Module | null,
  ) {
    this.bridgeCore = bridgeCore;
    this.gpuHost = gpuHost;
    this.device = device;
    this.format = format;
    this.findModule = findModule;
  }

  async ensureInstance(entry: ModuleEntry): Promise<LoadedModule> {
    let loaded = this.instances.get(entry.instance_key);
    if (loaded) return loaded;

    const host = new WasmHost();
    host.bridgeCore = this.bridgeCore;
    host.gpuHost = this.gpuHost;

    // Try to use a pre-compiled module from the registry
    const compiled = this.findModule(entry.module_type);
    if (compiled) {
      await host.load(compiled);
      const mod = host.activateEffect(entry.module_type);
      loaded = { host, module: mod };
    } else {
      // Fallback: load from URL (legacy single-effect modules)
      const moduleName = entry.module_type.replace(/^com\.nattos\./, '').replace(/\./g, '_');
      await host.load(`/wasm/${moduleName}.wasm`);
      const mod = host.activateEffect(entry.module_type);
      loaded = { host, module: mod };
    }

    this.instances.set(entry.instance_key, loaded);
    return loaded;
  }

  getInstance(instanceKey: string): LoadedModule | undefined {
    return this.instances.get(instanceKey);
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
          if (typeof value !== 'number') continue; // Only push numeric params
          // Set frameState.params by position for legacy host::param(index) reads
          loaded.host.frameState.params[paramIndex] = value;
          paramPatches.push({ op: 'replace', path: key, value });
          paramIndex++;
        }
        if (paramPatches.length > 0) {
          loaded.host.notifyStatePatched(loaded.module, paramPatches);
        }

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

  dispose() {
    this.instances.clear();
    for (const entry of this.sketchIntermediates.values()) {
      for (const tex of entry.textures) tex.destroy();
    }
    this.sketchIntermediates.clear();
  }
}
