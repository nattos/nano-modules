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

  private instances = new Map<string, LoadedModule>();
  private sketchIntermediates = new Map<string, { textures: GPUTexture[]; handles: number[] }>();

  constructor(bridgeCore: BridgeCore, gpuHost: GPUHost, device: GPUDevice, format: GPUTextureFormat) {
    this.bridgeCore = bridgeCore;
    this.gpuHost = gpuHost;
    this.device = device;
    this.format = format;
  }

  async ensureInstance(entry: ModuleEntry): Promise<LoadedModule> {
    let loaded = this.instances.get(entry.instance_key);
    if (loaded) return loaded;

    const host = new WasmHost();
    host.bridgeCore = this.bridgeCore;
    host.gpuHost = this.gpuHost;

    const moduleName = entry.module_type.replace(/^com\.nattos\./, '').replace(/\./g, '_');
    const mod = await host.load(`/wasm/${moduleName}.wasm`);
    mod.init();

    loaded = { host, module: mod };
    this.instances.set(entry.instance_key, loaded);
    return loaded;
  }

  getInstance(instanceKey: string): LoadedModule | undefined {
    return this.instances.get(instanceKey);
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
   * Execute a sketch column's chain with sideband rail routing.
   */
  async executeSketch(
    sketchId: string,
    sketch: Sketch,
    colIdx: number,
    inputTextureHandle: number,
    frameState: FrameState,
    width: number,
    height: number,
  ): Promise<number> {
    const column = sketch.columns[colIdx];
    if (!column) return inputTextureHandle;

    // Count module entries to allocate enough intermediates
    const moduleCount = column.chain.filter(e => e.type === 'module').length;
    const intermediates = this.ensureIntermediates(sketchId, Math.max(moduleCount, 2), width, height);

    // Rail values for this column's execution (scoped to this frame)
    const railValues = new Map<string, RailValue>();

    let currentInputHandle = inputTextureHandle;
    let nextSlot = 0;

    for (const entry of column.chain) {
      if (entry.type === 'texture_input') {
        continue;
      }

      if (entry.type === 'texture_output') {
        break;
      }

      if (entry.type === 'module') {
        const loaded = await this.ensureInstance(entry);

        // --- Apply params from chain entry ---
        const paramPatches: import('./wasm-host').PatchOp[] = [];
        let paramIndex = 0;
        for (const [key, value] of Object.entries(entry.params)) {
          // Set frameState.params by position for legacy host::param(index) reads
          loaded.host.frameState.params[paramIndex] = value;
          // Also call legacy onParamChange for modules that haven't migrated
          loaded.module.onParamChange(paramIndex, value);
          // Build patch for the new on_state_patched path
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
            const rv = railValues.get(tap.railId);
            if (!rv) continue;

            const rail = column.rails?.find(r => r.id === tap.railId);

            if (rail?.dataType === 'float' && rv.data !== undefined) {
              // Data tap read: write rail value into module params
              const paramIdx = parseInt(tap.fieldPath, 10);
              if (!isNaN(paramIdx)) {
                loaded.host.frameState.params[paramIdx] = rv.data;
                loaded.module.onParamChange(paramIdx, rv.data);
              }
              entry.params[tap.fieldPath] = rv.data;
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
        const outputHandle = intermediates.handles[nextSlot];
        const outputTex = intermediates.textures[nextSlot];
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

            const rail = column.rails?.find(r => r.id === tap.railId);

            if (rail?.dataType === 'float') {
              // Data tap write: read from module's plugin state
              const value = this.readFieldFromState(loaded.host, tap.fieldPath);
              if (value !== undefined) {
                const existing = railValues.get(tap.railId) ?? {};
                existing.data = value;
                railValues.set(tap.railId, existing);
              }
            } else if (rail?.dataType === 'texture') {
              // Texture tap write: the module's output texture goes onto the rail
              const existing = railValues.get(tap.railId) ?? {};
              existing.texture = outputHandle;
              railValues.set(tap.railId, existing);
            }
          }
        }

        // --- Advance chain ---
        currentInputHandle = outputHandle;
        nextSlot++;
      }
    }

    return currentInputHandle;
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
