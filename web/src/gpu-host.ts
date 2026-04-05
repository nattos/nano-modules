/**
 * GPU Host — WebGPU implementation of the gpu.* WASM host functions.
 *
 * Provides a Metal-like API surface backed by WebGPU. Modules create
 * shader modules, buffers, textures, pipelines, and encode compute/render
 * commands via host function calls.
 */

const USAGE_VERTEX = 0;
const USAGE_STORAGE = 1;
const USAGE_UNIFORM = 2;

type HandleType = 'buffer' | 'texture' | 'shader' | 'compute_pipeline' | 'render_pipeline';

interface HandleEntry {
  type: HandleType;
  resource: any;
}

export class GPUHost {
  private device: GPUDevice;
  private handles = new Map<number, HandleEntry>();
  private nextHandle = 1;

  // Current frame state
  private encoder: GPUCommandEncoder | null = null;
  private surfaceTexture: GPUTexture | null = null;
  private surfaceWidth = 0;
  private surfaceHeight = 0;
  private surfaceHandle = -1;
  private surfaceFormat: GPUTextureFormat;

  // Bind group layout cache for compute pipelines
  private computeBindGroupLayouts = new Map<number, GPUBindGroupLayout>();
  private renderBindGroupLayouts = new Map<number, GPUBindGroupLayout>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.surfaceFormat = format;
  }

  private alloc(type: HandleType, resource: any): number {
    const h = this.nextHandle++;
    this.handles.set(h, { type, resource });
    return h;
  }

  private get(handle: number): any {
    return this.handles.get(handle)?.resource;
  }

  // --- Surface management ---

  setSurface(texture: GPUTexture, width: number, height: number) {
    this.surfaceTexture = texture;
    this.surfaceWidth = width;
    this.surfaceHeight = height;
    // Update or create surface handle
    if (this.surfaceHandle > 0) {
      this.handles.set(this.surfaceHandle, { type: 'texture', resource: texture });
    } else {
      this.surfaceHandle = this.alloc('texture', texture);
    }
  }

  // --- Resource creation ---

  createShaderModule(source: string): number {
    try {
      const module = this.device.createShaderModule({ code: source });
      return this.alloc('shader', module);
    } catch (e) {
      console.error('[gpu] shader compile error:', e);
      return -1;
    }
  }

  createBuffer(size: number, usage: number): number {
    let gpuUsage = GPUBufferUsage.COPY_DST;
    if (usage === USAGE_VERTEX) gpuUsage |= GPUBufferUsage.VERTEX;
    if (usage === USAGE_STORAGE) gpuUsage |= GPUBufferUsage.STORAGE;
    if (usage === USAGE_UNIFORM) gpuUsage |= GPUBufferUsage.UNIFORM;
    // Storage buffers also need VERTEX for reading as vertex in render pass
    if (usage === USAGE_STORAGE) gpuUsage |= GPUBufferUsage.VERTEX;

    const buffer = this.device.createBuffer({ size, usage: gpuUsage });
    return this.alloc('buffer', buffer);
  }

  createTexture(width: number, height: number, format: number): number {
    const fmt: GPUTextureFormat = format === 0 ? 'bgra8unorm' : 'rgba8unorm';
    const texture = this.device.createTexture({
      size: [width, height],
      format: fmt,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    return this.alloc('texture', texture);
  }

  createComputePipeline(shaderHandle: number, entryPoint: string): number {
    const shaderModule = this.get(shaderHandle) as GPUShaderModule;
    if (!shaderModule) return -1;

    // Auto-layout — WebGPU figures out bind group layout from shader
    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint },
    });
    return this.alloc('compute_pipeline', pipeline);
  }

  createRenderPipeline(vsShaderHandle: number, vsEntry: string,
                       fsShaderHandle: number, fsEntry: string, format: number): number {
    const vsModule = this.get(vsShaderHandle) as GPUShaderModule;
    const fsModule = this.get(fsShaderHandle) as GPUShaderModule;
    if (!vsModule || !fsModule) return -1;

    const fmt: GPUTextureFormat = format === 0 ? 'bgra8unorm' :
                                   format === 1 ? 'rgba8unorm' : this.surfaceFormat;

    const pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vsModule,
        entryPoint: vsEntry,
        buffers: [{
          arrayStride: 24, // Vertex: float2 pos + float4 color
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
            { shaderLocation: 1, offset: 8, format: 'float32x4' as GPUVertexFormat },
          ],
        }],
      },
      fragment: {
        module: fsModule,
        entryPoint: fsEntry,
        targets: [{ format: fmt, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }}],
      },
      primitive: { topology: 'triangle-list' },
    });
    return this.alloc('render_pipeline', pipeline);
  }

  // --- Buffer operations ---

  writeBuffer(bufHandle: number, offset: number, data: Uint8Array) {
    const buffer = this.get(bufHandle) as GPUBuffer;
    if (!buffer) return;
    this.device.queue.writeBuffer(buffer, offset, data);
  }

  // --- Command encoding ---

  private ensureEncoder(): GPUCommandEncoder {
    if (!this.encoder) {
      this.encoder = this.device.createCommandEncoder();
    }
    return this.encoder;
  }

  // Compute pass state
  private computePassEncoder: GPUComputePassEncoder | null = null;
  private computePassPipeline: GPUComputePipeline | null = null;
  private computePassBuffers: Map<number, GPUBuffer> = new Map();
  private computePassTextures: Map<number, { texture: GPUTexture; access: number }> = new Map();

  beginComputePass(): number {
    const encoder = this.ensureEncoder();
    this.computePassEncoder = encoder.beginComputePass();
    this.computePassPipeline = null;
    this.computePassBuffers.clear();
    this.computePassTextures.clear();
    return 1; // pass handle (only one at a time)
  }

  computeSetPipeline(_pass: number, pipelineHandle: number) {
    const pipeline = this.get(pipelineHandle) as GPUComputePipeline;
    if (!pipeline || !this.computePassEncoder) return;
    this.computePassEncoder.setPipeline(pipeline);
    this.computePassPipeline = pipeline;
  }

  computeSetBuffer(_pass: number, bufHandle: number, _offset: number, slot: number) {
    const buffer = this.get(bufHandle) as GPUBuffer;
    if (!buffer) return;
    this.computePassBuffers.set(slot, buffer);
  }

  computeSetTexture(_pass: number, texHandle: number, slot: number, access: number) {
    const texture = this.get(texHandle) as GPUTexture;
    if (!texture) return;
    this.computePassTextures.set(slot, { texture, access });
  }

  computeDispatch(_pass: number, x: number, y: number, z: number) {
    if (!this.computePassEncoder || !this.computePassPipeline) return;
    // Create bind group with all collected buffers and textures just before dispatch
    const entries: GPUBindGroupEntry[] = [];
    for (const [binding, buffer] of this.computePassBuffers) {
      entries.push({ binding, resource: { buffer } });
    }
    for (const [binding, { texture }] of this.computePassTextures) {
      entries.push({ binding, resource: texture.createView() });
    }
    if (entries.length > 0) {
      const bindGroup = this.device.createBindGroup({
        layout: this.computePassPipeline.getBindGroupLayout(0),
        entries,
      });
      this.computePassEncoder.setBindGroup(0, bindGroup);
    }
    this.computePassEncoder.dispatchWorkgroups(x, y, z);
  }

  endComputePass(_pass: number) {
    if (this.computePassEncoder) {
      this.computePassEncoder.end();
      this.computePassEncoder = null;
      this.computePassPipeline = null;
      this.computePassBuffers.clear();
      this.computePassTextures.clear();
    }
  }

  // Render pass state
  private renderPassEncoder: GPURenderPassEncoder | null = null;

  beginRenderPass(textureHandle: number, clearR: number, clearG: number, clearB: number, clearA: number): number {
    const texture = this.get(textureHandle) as GPUTexture;
    if (!texture) return -1;

    const encoder = this.ensureEncoder();
    this.renderPassEncoder = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: clearR, g: clearG, b: clearB, a: clearA },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    return 1;
  }

  renderSetPipeline(_pass: number, pipelineHandle: number) {
    const pipeline = this.get(pipelineHandle) as GPURenderPipeline;
    if (!pipeline || !this.renderPassEncoder) return;
    this.renderPassEncoder.setPipeline(pipeline);
  }

  renderSetVertexBuffer(_pass: number, bufHandle: number, offset: number, slot: number) {
    const buffer = this.get(bufHandle) as GPUBuffer;
    if (!buffer || !this.renderPassEncoder) return;
    this.renderPassEncoder.setVertexBuffer(slot, buffer, offset);
  }

  renderDraw(_pass: number, vertexCount: number, instanceCount: number) {
    if (!this.renderPassEncoder) return;
    this.renderPassEncoder.draw(vertexCount, instanceCount);
  }

  endRenderPass(_pass: number) {
    if (this.renderPassEncoder) {
      this.renderPassEncoder.end();
      this.renderPassEncoder = null;
    }
  }

  flush() {
    if (this.encoder) {
      this.device.queue.submit([this.encoder.finish()]);
      this.encoder = null;
    }
  }

  // --- Readback (for testing) ---

  async readbackTexture(textureHandle: number, width: number, height: number): Promise<Uint8Array> {
    const texture = this.get(textureHandle) as GPUTexture;
    if (!texture) return new Uint8Array(0);

    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const bufferSize = bytesPerRow * height;
    const staging = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: staging, bytesPerRow },
      [width, height],
    );
    this.device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(staging.getMappedRange());

    const result = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      result.set(
        mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4),
        row * width * 4,
      );
    }
    staging.unmap();
    staging.destroy();
    return result;
  }

  // --- Queries ---

  getSurfaceTexture(): number { return this.surfaceHandle; }
  getSurfaceWidth(): number { return this.surfaceWidth; }
  getSurfaceHeight(): number { return this.surfaceHeight; }
  getBackend(): number { return 1; } // 1 = WebGPU

  // --- Cleanup ---

  release(handle: number) {
    const entry = this.handles.get(handle);
    if (!entry || handle === this.surfaceHandle) return;
    if (entry.type === 'buffer') (entry.resource as GPUBuffer).destroy();
    if (entry.type === 'texture') (entry.resource as GPUTexture).destroy();
    this.handles.delete(handle);
  }

  // --- Build import object for WASM ---

  /** Inject an externally-owned texture into the handle space (for chaining). */
  injectTexture(texture: GPUTexture): number {
    return this.alloc('texture', texture);
  }

  buildImports(readMemory: (ptr: number, len: number) => Uint8Array,
               readString: (ptr: number, len: number) => string): Record<string, Function> {
    return {
      get_backend: () => this.getBackend(),
      create_shader_module: (srcPtr: number, srcLen: number) =>
        this.createShaderModule(readString(srcPtr, srcLen)),
      create_buffer: (size: number, usage: number) =>
        this.createBuffer(size, usage),
      create_texture: (w: number, h: number, format: number) =>
        this.createTexture(w, h, format),
      create_compute_pso: (shader: number, entryPtr: number, entryLen: number) =>
        this.createComputePipeline(shader, readString(entryPtr, entryLen)),
      create_render_pso: (vsShader: number, vsPtr: number, vsLen: number,
                           fsShader: number, fsPtr: number, fsLen: number, format: number) =>
        this.createRenderPipeline(vsShader, readString(vsPtr, vsLen),
                                  fsShader, readString(fsPtr, fsLen), format),
      write_buffer: (buf: number, offset: number, dataPtr: number, dataLen: number) =>
        this.writeBuffer(buf, offset, readMemory(dataPtr, dataLen)),
      begin_compute_pass: () => this.beginComputePass(),
      compute_set_pso: (pass: number, pipeline: number) =>
        this.computeSetPipeline(pass, pipeline),
      compute_set_buffer: (pass: number, buf: number, offset: number, slot: number) =>
        this.computeSetBuffer(pass, buf, offset, slot),
      compute_set_texture: (pass: number, tex: number, slot: number, access: number) =>
        this.computeSetTexture(pass, tex, slot, access),
      compute_dispatch: (pass: number, x: number, y: number, z: number) =>
        this.computeDispatch(pass, x, y, z),
      end_compute_pass: (pass: number) => this.endComputePass(pass),
      begin_render_pass: (texture: number, cr: number, cg: number, cb: number, ca: number) =>
        this.beginRenderPass(texture, cr, cg, cb, ca),
      render_set_pso: (pass: number, pipeline: number) =>
        this.renderSetPipeline(pass, pipeline),
      render_set_vertex_buffer: (pass: number, buf: number, offset: number, slot: number) =>
        this.renderSetVertexBuffer(pass, buf, offset, slot),
      render_draw: (pass: number, vertexCount: number, instanceCount: number) =>
        this.renderDraw(pass, vertexCount, instanceCount),
      end_render_pass: (pass: number) => this.endRenderPass(pass),
      submit: () => this.flush(),
      get_render_target: () => this.getSurfaceTexture(),
      get_render_target_width: () => this.getSurfaceWidth(),
      get_render_target_height: () => this.getSurfaceHeight(),
      release: (handle: number) => this.release(handle),
    };
  }
}
