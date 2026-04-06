/**
 * Sketch executor — walks a chain of virtual module instances,
 * piping texture outputs from one module into the next.
 *
 * Manages virtual module lifecycle, intermediate render targets,
 * and parameter injection.
 */

import type { BridgeCore } from './bridge-core';
import type { GPUHost } from './gpu-host';
import { WasmHost, WasmModule, FrameState } from './wasm-host';
import type { ChainEntry, ModuleEntry, Sketch } from './sketch-types';

interface LoadedModule {
  host: WasmHost;
  module: WasmModule;
}

export class SketchExecutor {
  private bridgeCore: BridgeCore;
  private gpuHost: GPUHost;
  private device: GPUDevice;
  private format: GPUTextureFormat;

  /** Loaded virtual module instances by instance key. */
  private instances = new Map<string, LoadedModule>();

  /** Intermediate render target textures (recycled across frames). */
  private intermediateTextures: GPUTexture[] = [];
  private intermediateHandles: number[] = [];

  constructor(bridgeCore: BridgeCore, gpuHost: GPUHost, device: GPUDevice, format: GPUTextureFormat) {
    this.bridgeCore = bridgeCore;
    this.gpuHost = gpuHost;
    this.device = device;
    this.format = format;
  }

  /** Get or create a virtual module instance by its instance key. */
  async ensureInstance(entry: ModuleEntry): Promise<LoadedModule> {
    let loaded = this.instances.get(entry.instance_key);
    if (loaded) return loaded;

    const host = new WasmHost();
    host.bridgeCore = this.bridgeCore;
    host.gpuHost = this.gpuHost;

    const moduleName = entry.module_type.split('.').pop() ?? entry.module_type;
    const mod = await host.load(`/wasm/${moduleName}.wasm`);
    mod.init();

    loaded = { host, module: mod };
    this.instances.set(entry.instance_key, loaded);
    return loaded;
  }

  /** Get a loaded instance (if already loaded). */
  getInstance(instanceKey: string): LoadedModule | undefined {
    return this.instances.get(instanceKey);
  }

  /**
   * Ensure we have enough intermediate textures for the chain.
   * We ping-pong between two textures.
   */
  private ensureIntermediates(width: number, height: number) {
    // We need at most 2 intermediates for ping-pong
    const needed = 2;
    while (this.intermediateTextures.length < needed) {
      const tex = this.device.createTexture({
        size: [width, height],
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
             | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const handle = this.gpuHost.injectTexture(tex);
      this.intermediateTextures.push(tex);
      this.intermediateHandles.push(handle);
    }

    // Resize if dimensions changed
    for (let i = 0; i < needed; i++) {
      const tex = this.intermediateTextures[i];
      if (tex.width !== width || tex.height !== height) {
        tex.destroy();
        const newTex = this.device.createTexture({
          size: [width, height],
          format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
               | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        // Re-inject into the same handle slot
        this.intermediateHandles[i] = this.gpuHost.injectTexture(newTex);
        this.intermediateTextures[i] = newTex;
      }
    }
  }

  /**
   * Execute a sketch's chain. Returns the GPU texture handle of the final output.
   *
   * @param sketch The sketch to execute
   * @param colIdx Which column to execute (usually 0)
   * @param inputTextureHandle Handle to the input texture (from anchor module's output), or -1
   * @param frameState Current frame timing state
   * @param width Viewport width
   * @param height Viewport height
   */
  async executeSketch(
    sketch: Sketch,
    colIdx: number,
    inputTextureHandle: number,
    frameState: FrameState,
    width: number,
    height: number,
  ): Promise<number> {
    const column = sketch.columns[colIdx];
    if (!column) return inputTextureHandle;

    this.ensureIntermediates(width, height);

    let currentInputHandle = inputTextureHandle;
    let pingPong = 0; // alternates between 0 and 1

    for (const entry of column.chain) {
      if (entry.type === 'texture_input') {
        // Input marker — currentInputHandle is already set
        continue;
      }

      if (entry.type === 'texture_output') {
        // Output marker — we're done
        break;
      }

      if (entry.type === 'module') {
        const loaded = await this.ensureInstance(entry);

        // Set parameters from the chain entry
        for (const [key, value] of Object.entries(entry.params)) {
          const paramIndex = parseInt(key, 10);
          if (!isNaN(paramIndex)) {
            loaded.host.frameState.params[paramIndex] = value;
            loaded.module.onParamChange(paramIndex, value);
          }
        }

        // Inject input texture
        loaded.host.inputTextureHandles = currentInputHandle >= 0 ? [currentInputHandle] : [];

        // Copy frame timing
        loaded.host.frameState.elapsedTime = frameState.elapsedTime;
        loaded.host.frameState.deltaTime = frameState.deltaTime;
        loaded.host.frameState.barPhase = frameState.barPhase;
        loaded.host.frameState.bpm = frameState.bpm;
        loaded.host.frameState.viewportW = width;
        loaded.host.frameState.viewportH = height;

        // Set the intermediate texture as the render target
        const outputHandle = this.intermediateHandles[pingPong];
        const outputTex = this.intermediateTextures[pingPong];
        this.gpuHost.setSurface(outputTex, width, height);

        // Render
        loaded.host.drawList = [];
        loaded.module.render(width, height);

        // This step's output becomes next step's input
        currentInputHandle = outputHandle;
        pingPong = 1 - pingPong;
      }
    }

    return currentInputHandle;
  }

  /** Clean up all loaded virtual instances and textures. */
  dispose() {
    this.instances.clear();
    for (const tex of this.intermediateTextures) {
      tex.destroy();
    }
    this.intermediateTextures = [];
    this.intermediateHandles = [];
  }
}
