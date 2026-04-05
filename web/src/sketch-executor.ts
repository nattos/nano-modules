/**
 * Sketch executor — walks a chain of virtual module instances,
 * piping texture outputs from one module into the next.
 */

import type { BridgeCore } from './bridge-core';
import type { GPUHost } from './gpu-host';
import { WasmHost, WasmModule, FrameState } from './wasm-host';
import type { ChainEntry, ModuleEntry } from './sketch-types';

interface LoadedModule {
  host: WasmHost;
  module: WasmModule;
}

export class SketchExecutor {
  private bridgeCore: BridgeCore;
  private gpuHost: GPUHost;

  /** Cached WASM bytecode by module type (URL). */
  private wasmCache: Map<string, ArrayBuffer> = new Map();

  /** Loaded virtual module instances by instance key. */
  private instances: Map<string, LoadedModule> = new Map();

  constructor(bridgeCore: BridgeCore, gpuHost: GPUHost) {
    this.bridgeCore = bridgeCore;
    this.gpuHost = gpuHost;
  }

  /**
   * Ensure a module type is loaded and cached. Returns bytes from cache.
   */
  private async fetchModule(moduleType: string): Promise<ArrayBuffer> {
    // Map module type to wasm URL: "com.nattos.brightness_contrast" -> "wasm/brightness_contrast.wasm"
    const moduleName = moduleType.split('.').pop() ?? moduleType;
    const url = `wasm/${moduleName}.wasm`;

    let bytes = this.wasmCache.get(moduleType);
    if (!bytes) {
      const response = await fetch(url);
      bytes = await response.arrayBuffer();
      this.wasmCache.set(moduleType, bytes);
    }
    return bytes;
  }

  /**
   * Get or create a virtual module instance by its instance key.
   */
  private async ensureInstance(entry: ModuleEntry): Promise<LoadedModule> {
    let loaded = this.instances.get(entry.instance_key);
    if (loaded) return loaded;

    // Create a new WasmHost for this virtual instance
    const host = new WasmHost();
    host.bridgeCore = this.bridgeCore;
    host.gpuHost = this.gpuHost;

    const module = await host.load(`/wasm/${entry.module_type.split('.').pop()}.wasm`);
    module.init();

    loaded = { host, module };
    this.instances.set(entry.instance_key, loaded);
    return loaded;
  }

  /**
   * Execute a chain of processing steps.
   *
   * @param chain The chain entries to execute
   * @param inputTextureHandle Handle to the input texture (from anchor module's output)
   * @param frameState Current frame timing state
   * @param width Viewport width
   * @param height Viewport height
   * @returns The output texture handle after the chain
   */
  async executeChain(
    chain: ChainEntry[],
    inputTextureHandle: number,
    frameState: FrameState,
    width: number,
    height: number,
  ): Promise<number> {
    let currentTexture = inputTextureHandle;

    for (const entry of chain) {
      if (entry.type === 'texture_input') {
        // Input marker — currentTexture is already set
        continue;
      }

      if (entry.type === 'texture_output') {
        // Output marker — return current texture
        break;
      }

      if (entry.type === 'module') {
        const loaded = await this.ensureInstance(entry);

        // Set parameters
        for (const [key, value] of Object.entries(entry.params)) {
          const paramIndex = parseInt(key, 10);
          if (!isNaN(paramIndex)) {
            loaded.host.frameState.params[paramIndex] = value;
            loaded.module.onParamChange(paramIndex, value);
          }
        }

        // Inject input texture
        loaded.host.inputTextureHandles = [currentTexture];

        // Copy frame timing
        loaded.host.frameState.elapsedTime = frameState.elapsedTime;
        loaded.host.frameState.deltaTime = frameState.deltaTime;
        loaded.host.frameState.barPhase = frameState.barPhase;
        loaded.host.frameState.bpm = frameState.bpm;
        loaded.host.frameState.viewportW = width;
        loaded.host.frameState.viewportH = height;

        // Create intermediate output texture (or use render target)
        // The module writes to its render target, which we need to set up
        // For now, we let the module render to the shared GPU surface
        // and capture the result

        loaded.module.render(width, height);

        // The output texture is the render target
        // In practice, the sketch executor would create an intermediate texture
        // and set it as the render target. For now, modules render to the
        // shared surface.
        currentTexture = -1; // will be the surface texture
      }
    }

    return currentTexture;
  }

  /** Clean up all loaded virtual instances. */
  dispose() {
    this.instances.clear();
    this.wasmCache.clear();
  }
}
