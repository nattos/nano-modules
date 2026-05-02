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

// Keep in sync with `enum class TextureFormat` in native/wasm_modules/include/gpu.h.
//   0 BGRA8 / 1 RGBA8 / 2 Surface (alias for the configured surface format)
//   3 RGBA16F / 4 R32F / 5 RGBA32F (HDR / extended-precision)
function textureFormatFromCode(code: number): GPUTextureFormat {
  switch (code) {
    case 0: return 'bgra8unorm';
    case 3: return 'rgba16float';
    case 4: return 'r32float';
    case 5: return 'rgba32float';
    case 1:
    default: return 'rgba8unorm';
  }
}

type HandleType = 'buffer' | 'texture' | 'sampler' | 'shader' | 'compute_pipeline' | 'render_pipeline';

interface HandleEntry {
  type: HandleType;
  resource: any;
}

// --- Explicit bind group layouts ---
//
// The host defaults to WebGPU's 'auto' layout, which derives the bind
// group layout from the shader. That breaks any time the shader's
// declared bindings diverge from what the C++ side actually binds —
// most acutely when shaders use conditional compilation, but also
// when an effect re-uses the same shader source for two PSOs that
// bind different subsets, or when naga prunes an unused binding the
// host still wants to keep.
//
// The fix: let the C++ side declare its bindings up front. We build
// an explicit GPUBindGroupLayout from that declaration and stamp the
// pipeline with it. Bindings declared but unused by the shader are
// fine (WebGPU only requires the shader's bindings to be a subset of
// the layout). At dispatch time we walk the declared layout in order
// and pull each bound resource out of the per-pass slot map — so the
// bind group is constructed in lockstep with the layout, regardless
// of which slots the shader actually reads.

// Wire-format integers for binding kinds. Keep in sync with
// `enum class BindingKind` in native/wasm_modules/include/gpu.h.
const BIND_UNIFORM            = 0;
const BIND_STORAGE_RO         = 1;
const BIND_STORAGE_RW         = 2;
const BIND_SAMPLER            = 3;
const BIND_TEXTURE_2D         = 4;
const BIND_TEXTURE_3D         = 5;
const BIND_TEXTURE_2D_ARRAY   = 6;
const BIND_STORAGE_TEXTURE_2D = 7;
const BIND_STORAGE_TEXTURE_3D = 8;

interface BindingDecl {
  slot: number;
  kind: number;
  format: number;     // TextureFormat code (storage textures only)
  access: number;     // 0=read, 1=write, 2=read_write (storage textures only)
}

interface PipelineEntry {
  pipeline: GPUComputePipeline | GPURenderPipeline;
  // The bind group layout we built from the C++ side's declared
  // bindings. Null when the pipeline declared no bindings — in that
  // case dispatch skips setBindGroup entirely.
  bindGroupLayout: GPUBindGroupLayout | null;
  // Always non-null — every pipeline now declares its bindings up
  // front. Empty array means "no bind groups".
  bindings: BindingDecl[];
}

/// Read N binding decls (4 int32s each: slot, kind, format, access) out of
/// a flat byte buffer. The C++ side packs them into one contiguous array.
function readBindingDecls(bytes: Uint8Array, count: number): BindingDecl[] {
  const view = new Int32Array(bytes.buffer, bytes.byteOffset, count * 4);
  const out: BindingDecl[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      slot: view[i * 4],
      kind: view[i * 4 + 1],
      format: view[i * 4 + 2],
      access: view[i * 4 + 3],
    });
  }
  return out;
}

function bindingDeclToLayoutEntry(b: BindingDecl, visibility: number): GPUBindGroupLayoutEntry {
  const e: GPUBindGroupLayoutEntry = { binding: b.slot, visibility };
  switch (b.kind) {
    case BIND_UNIFORM:
      e.buffer = { type: 'uniform' };
      break;
    case BIND_STORAGE_RO:
      e.buffer = { type: 'read-only-storage' };
      break;
    case BIND_STORAGE_RW:
      e.buffer = { type: 'storage' };
      break;
    case BIND_SAMPLER:
      e.sampler = { type: 'filtering' };
      break;
    case BIND_TEXTURE_2D:
      e.texture = { sampleType: 'float', viewDimension: '2d' };
      break;
    case BIND_TEXTURE_3D:
      e.texture = { sampleType: 'float', viewDimension: '3d' };
      break;
    case BIND_TEXTURE_2D_ARRAY:
      e.texture = { sampleType: 'float', viewDimension: '2d-array' };
      break;
    case BIND_STORAGE_TEXTURE_2D:
      e.storageTexture = {
        format: textureFormatFromCode(b.format),
        access: b.access === 2 ? 'read-write' : b.access === 0 ? 'read-only' : 'write-only',
        viewDimension: '2d',
      };
      break;
    case BIND_STORAGE_TEXTURE_3D:
      e.storageTexture = {
        format: textureFormatFromCode(b.format),
        access: b.access === 2 ? 'read-write' : b.access === 0 ? 'read-only' : 'write-only',
        viewDimension: '3d',
      };
      break;
    default:
      throw new Error(`Unknown binding kind ${b.kind} at slot ${b.slot}`);
  }
  return e;
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

  /** Get the underlying GPUTexture for a handle (for external blit operations). */
  getTextureByHandle(handle: number): GPUTexture | null {
    const entry = this.handles.get(handle);
    if (entry?.type === 'texture') return entry.resource as GPUTexture;
    return null;
  }

  /** Get the underlying GPUBuffer for a handle (for external copy/readback). */
  getBufferByHandle(handle: number): GPUBuffer | null {
    const entry = this.handles.get(handle);
    if (entry?.type === 'buffer') return entry.resource as GPUBuffer;
    return null;
  }

  /** Inject an externally-owned buffer into the handle space (for chaining). */
  injectBuffer(buffer: GPUBuffer): number {
    return this.alloc('buffer', buffer);
  }

  // --- Sampler creation ---

  /**
   * Create a sampler resource for use in compute / render passes.
   * `filterMode`: 0 = nearest, 1 = linear. `addressMode`: 0 = clamp-to-edge,
   * 1 = repeat, 2 = mirror-repeat. Mip filtering follows the magnification
   * filter mode.
   */
  createSampler(filterMode: number, addressMode: number): number {
    const filter: GPUFilterMode = filterMode === 1 ? 'linear' : 'nearest';
    const addr: GPUAddressMode =
      addressMode === 1 ? 'repeat'
      : addressMode === 2 ? 'mirror-repeat'
      : 'clamp-to-edge';
    const sampler = this.device.createSampler({
      magFilter: filter,
      minFilter: filter,
      mipmapFilter: filter,
      addressModeU: addr,
      addressModeV: addr,
      addressModeW: addr,
    });
    return this.alloc('sampler', sampler);
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

  /**
   * Create a 3D texture (texture_3d / texture_storage_3d in WGSL).
   * Supports the same set of formats as `createTexture`. Useful for
   * color LUTs (16³–32³ rgba8 cube), particle density volumes, and any
   * 3-axis sampled lookup table. Always allocates with TEXTURE_BINDING +
   * STORAGE_BINDING + COPY_SRC + COPY_DST so the same texture can be
   * filled by a compute shader and later read either via storage or
   * sampling (where the format/feature pair allows).
   */
  createTexture3D(width: number, height: number, depth: number, format: number): number {
    const fmt = format === 2 ? this.surfaceFormat : textureFormatFromCode(format);
    const texture = this.device.createTexture({
      size: [width, height, depth],
      dimension: '3d',
      format: fmt,
      usage:
        GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.COPY_SRC
        | GPUTextureUsage.COPY_DST,
    });
    return this.alloc('texture', texture);
  }

  createTexture(width: number, height: number, format: number): number {
    const fmt = format === 2 ? this.surfaceFormat : textureFormatFromCode(format);
    // RENDER_ATTACHMENT is meaningful for the 8-bit color formats and rgba16f
    // (all renderable in core WebGPU). For r32float / rgba32float, omit it —
    // those aren't core renderable formats.
    const renderable = (fmt === 'bgra8unorm' || fmt === 'rgba8unorm' || fmt === 'rgba16float');
    const usage =
      GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.STORAGE_BINDING
      | GPUTextureUsage.COPY_SRC
      | GPUTextureUsage.COPY_DST
      | (renderable ? GPUTextureUsage.RENDER_ATTACHMENT : 0);
    const texture = this.device.createTexture({
      size: [width, height],
      format: fmt,
      usage,
    });
    return this.alloc('texture', texture);
  }

  /**
   * Compute pipeline with an explicit bind group layout. The layout
   * must list all bindings the shader uses (it may also list extras
   * the shader doesn't currently reference — useful when the same
   * source is conditionally compiled into different binding subsets,
   * or when the host wants to keep a slot reserved for future use).
   * Bind groups built at dispatch time are constructed against this
   * layout, in the declared order, by looking up resources from the
   * per-pass slot maps.
   *
   * An empty `bindings` array creates a pipeline with no bind groups —
   * useful for shaders that don't use any bindings (very rare for
   * compute, but valid).
   */
  createComputePipelineWithLayout(
      shaderHandle: number, entryPoint: string,
      bindings: BindingDecl[]): number {
    const shaderModule = this.get(shaderHandle) as GPUShaderModule;
    if (!shaderModule) return -1;
    const { pipelineLayout, bindGroupLayout } = this.buildLayouts(bindings, GPUShaderStage.COMPUTE);
    const pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint },
    });
    const entry: PipelineEntry = { pipeline, bindGroupLayout, bindings };
    return this.alloc('compute_pipeline', entry);
  }

  /**
   * Build a (pipelineLayout, bindGroupLayout) pair for an explicit-
   * layout pipeline. An empty `bindings` collapses to an empty
   * pipeline layout (no bind groups at all); a non-empty list
   * produces a single bind group with the declared entries. The
   * returned `bindGroupLayout` is null in the empty case so dispatch
   * knows to skip setBindGroup entirely.
   */
  private buildLayouts(bindings: BindingDecl[], visibility: number): {
    pipelineLayout: GPUPipelineLayout;
    bindGroupLayout: GPUBindGroupLayout | null;
  } {
    if (bindings.length === 0) {
      return {
        pipelineLayout: this.device.createPipelineLayout({ bindGroupLayouts: [] }),
        bindGroupLayout: null,
      };
    }
    const entries = bindings.map(b => bindingDeclToLayoutEntry(b, visibility));
    const bindGroupLayout = this.device.createBindGroupLayout({ entries });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    return { pipelineLayout, bindGroupLayout };
  }

  /// MRT render pipeline (no vertex buffer). `formats[i]` is the
  /// format code for fragment output `@location(i)`. Bindings (visible
  /// to vertex+fragment) are explicit. No blend — MRT pipelines are
  /// typically opaque writes; callers can extend if they need blend.
  createInstancedRenderPipelineMRTWithLayout(
      vsShaderHandle: number, vsEntry: string,
      fsShaderHandle: number, fsEntry: string,
      count: number, formats: Int32Array,
      bindings: BindingDecl[]): number {
    const vsModule = this.get(vsShaderHandle) as GPUShaderModule;
    const fsModule = this.get(fsShaderHandle) as GPUShaderModule;
    if (!vsModule || !fsModule) return -1;

    const targets: GPUColorTargetState[] = [];
    for (let i = 0; i < count; i++) {
      const fmt = formats[i] === 2 ? this.surfaceFormat : textureFormatFromCode(formats[i]);
      targets.push({ format: fmt });
    }
    const { pipelineLayout, bindGroupLayout } = this.buildLayouts(
      bindings, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: vsModule, entryPoint: vsEntry, buffers: [] },
      fragment: { module: fsModule, entryPoint: fsEntry, targets },
      primitive: { topology: 'triangle-list' },
    });
    const entry: PipelineEntry = { pipeline, bindGroupLayout, bindings };
    return this.alloc('render_pipeline', entry);
  }

  /**
   * Create a render pipeline with no vertex buffer — the vertex shader
   * is expected to read per-instance data from a storage buffer bound
   * via RenderPass.setBuffer (and to compute position from vertex_index
   * + instance_index). Bind groups are derived automatically.
   */
  /// Render pipeline with the standard float2-position + float4-color
  /// vertex buffer attached. Bindings are explicit (vertex+fragment
  /// visibility); pass an empty list for shaders that read no bind
  /// group resources.
  createRenderPipelineWithLayout(
      vsShaderHandle: number, vsEntry: string,
      fsShaderHandle: number, fsEntry: string, format: number,
      bindings: BindingDecl[]): number {
    const vsModule = this.get(vsShaderHandle) as GPUShaderModule;
    const fsModule = this.get(fsShaderHandle) as GPUShaderModule;
    if (!vsModule || !fsModule) return -1;
    const fmt: GPUTextureFormat = format === 2 ? this.surfaceFormat
                                                : textureFormatFromCode(format);
    const { pipelineLayout, bindGroupLayout } = this.buildLayouts(
      bindings, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: vsModule, entryPoint: vsEntry,
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat },
            { shaderLocation: 1, offset: 8, format: 'float32x4' as GPUVertexFormat },
          ],
        }],
      },
      fragment: {
        module: fsModule, entryPoint: fsEntry,
        targets: [{ format: fmt, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }}],
      },
      primitive: { topology: 'triangle-list' },
    });
    const entry: PipelineEntry = { pipeline, bindGroupLayout, bindings };
    return this.alloc('render_pipeline', entry);
  }

  /// Vertex-buffer-free render pipeline. Vertex shader uses
  /// vertex_index / instance_index, optionally reading per-instance
  /// data from a storage buffer bound via one of the explicit
  /// `bindings` (visibility: vertex+fragment).
  createInstancedRenderPipelineWithLayout(
      vsShaderHandle: number, vsEntry: string,
      fsShaderHandle: number, fsEntry: string, format: number,
      bindings: BindingDecl[]): number {
    const vsModule = this.get(vsShaderHandle) as GPUShaderModule;
    const fsModule = this.get(fsShaderHandle) as GPUShaderModule;
    if (!vsModule || !fsModule) return -1;
    const fmt: GPUTextureFormat = format === 2 ? this.surfaceFormat
                                                : textureFormatFromCode(format);
    const { pipelineLayout, bindGroupLayout } = this.buildLayouts(
      bindings, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: vsModule, entryPoint: vsEntry, buffers: [] },
      fragment: {
        module: fsModule, entryPoint: fsEntry,
        targets: [{ format: fmt, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }}],
      },
      primitive: { topology: 'triangle-list' },
    });
    const entry: PipelineEntry = { pipeline, bindGroupLayout, bindings };
    return this.alloc('render_pipeline', entry);
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
  private computePassEntry: PipelineEntry | null = null;
  private computePassBuffers: Map<number, GPUBuffer> = new Map();
  private computePassTextures: Map<number, { texture: GPUTexture; access: number }> = new Map();
  private computePassSamplers: Map<number, GPUSampler> = new Map();

  beginComputePass(): number {
    const encoder = this.ensureEncoder();
    this.computePassEncoder = encoder.beginComputePass();
    this.computePassEntry = null;
    this.computePassBuffers.clear();
    this.computePassTextures.clear();
    this.computePassSamplers.clear();
    return 1; // pass handle (only one at a time)
  }

  computeSetPipeline(_pass: number, pipelineHandle: number) {
    const entry = this.get(pipelineHandle) as PipelineEntry | undefined;
    if (!entry || !this.computePassEncoder) return;
    this.computePassEncoder.setPipeline(entry.pipeline as GPUComputePipeline);
    this.computePassEntry = entry;
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

  computeSetSampler(_pass: number, samplerHandle: number, slot: number) {
    const sampler = this.get(samplerHandle) as GPUSampler;
    if (!sampler) return;
    this.computePassSamplers.set(slot, sampler);
  }

  computeDispatch(_pass: number, x: number, y: number, z: number) {
    if (!this.computePassEncoder || !this.computePassEntry) return;
    const entries = this.buildBindGroupEntries(this.computePassEntry, /*forCompute=*/true);
    if (entries && this.computePassEntry.bindGroupLayout) {
      const bindGroup = this.device.createBindGroup({
        layout: this.computePassEntry.bindGroupLayout,
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
      this.computePassEntry = null;
      this.computePassBuffers.clear();
      this.computePassTextures.clear();
      this.computePassSamplers.clear();
    }
  }

  /**
   * Construct the bind group entry list for the current pipeline. We
   * walk the declared bindings in order and look up each resource by
   * slot — guarantees the bind group matches the layout regardless of
   * which slots the shader actually reads.
   *
   * `forCompute` selects the right slot maps. Compute passes use the
   * compute slot maps; render passes use the render buffer map (no
   * texture/sampler bindings in render pipelines yet — easy to add
   * when needed).
   *
   * Returns null when the pipeline declared no bindings at all
   * (signals "skip setBindGroup"). Otherwise returns one entry per
   * declared binding.
   */
  private buildBindGroupEntries(pe: PipelineEntry, forCompute: boolean): GPUBindGroupEntry[] | null {
    if (pe.bindings.length === 0) return null;
    const out: GPUBindGroupEntry[] = [];
    for (const b of pe.bindings) {
      out.push({ binding: b.slot, resource: this.resolveBindingResource(b, forCompute) });
    }
    return out;
  }

  private resolveBindingResource(b: BindingDecl, forCompute: boolean): GPUBindingResource {
    switch (b.kind) {
      case BIND_UNIFORM:
      case BIND_STORAGE_RO:
      case BIND_STORAGE_RW: {
        const buffer = forCompute
          ? this.computePassBuffers.get(b.slot)
          : this.renderPassBuffers.get(b.slot);
        if (!buffer) throw new Error(`No buffer bound at slot ${b.slot} (declared in pipeline layout)`);
        return { buffer };
      }
      case BIND_SAMPLER: {
        const s = this.computePassSamplers.get(b.slot);
        if (!s) throw new Error(`No sampler bound at slot ${b.slot}`);
        return s;
      }
      case BIND_TEXTURE_2D:
      case BIND_TEXTURE_3D:
      case BIND_TEXTURE_2D_ARRAY:
      case BIND_STORAGE_TEXTURE_2D:
      case BIND_STORAGE_TEXTURE_3D: {
        const tex = this.computePassTextures.get(b.slot);
        if (!tex) throw new Error(`No texture bound at slot ${b.slot}`);
        // Use a default view — dimension follows the texture's own
        // dimension, matching what the layout expects.
        return tex.texture.createView();
      }
      default:
        throw new Error(`Unknown binding kind ${b.kind}`);
    }
  }

  // Render pass state
  private renderPassEncoder: GPURenderPassEncoder | null = null;
  private renderPassEntry: PipelineEntry | null = null;
  private renderPassBuffers: Map<number, GPUBuffer> = new Map();

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
    this.renderPassEntry = null;
    this.renderPassBuffers.clear();
    return 1;
  }

  /**
   * Begin a render pass with multiple color attachments (MRT). Each
   * fragment-shader output `@location(i)` writes into `tex_handles[i]`,
   * cleared to `clear_values[i*4..i*4+4]` (rgba). The matching pipeline
   * must have been created via createRenderPipelineMRT with the same
   * number and order of target formats.
   */
  beginRenderPassMRT(count: number, texHandles: Int32Array, clearValues: Float32Array): number {
    const encoder = this.ensureEncoder();
    const attachments: GPURenderPassColorAttachment[] = [];
    for (let i = 0; i < count; i++) {
      const t = this.get(texHandles[i]) as GPUTexture | undefined;
      if (!t) return -1;
      attachments.push({
        view: t.createView(),
        clearValue: {
          r: clearValues[i * 4],
          g: clearValues[i * 4 + 1],
          b: clearValues[i * 4 + 2],
          a: clearValues[i * 4 + 3],
        },
        loadOp: 'clear',
        storeOp: 'store',
      });
    }
    this.renderPassEncoder = encoder.beginRenderPass({ colorAttachments: attachments });
    this.renderPassEntry = null;
    this.renderPassBuffers.clear();
    return 1;
  }

  renderSetPipeline(_pass: number, pipelineHandle: number) {
    const entry = this.get(pipelineHandle) as PipelineEntry | undefined;
    if (!entry || !this.renderPassEncoder) return;
    this.renderPassEncoder.setPipeline(entry.pipeline as GPURenderPipeline);
    this.renderPassEntry = entry;
  }

  renderSetVertexBuffer(_pass: number, bufHandle: number, offset: number, slot: number) {
    const buffer = this.get(bufHandle) as GPUBuffer;
    if (!buffer || !this.renderPassEncoder) return;
    this.renderPassEncoder.setVertexBuffer(slot, buffer, offset);
  }

  /** Bind a storage/uniform buffer to the active render pipeline. */
  renderSetBuffer(_pass: number, bufHandle: number, slot: number) {
    const buffer = this.get(bufHandle) as GPUBuffer;
    if (!buffer) return;
    this.renderPassBuffers.set(slot, buffer);
  }

  renderDraw(_pass: number, vertexCount: number, instanceCount: number) {
    if (!this.renderPassEncoder) return;
    if (this.renderPassEntry) {
      const entries = this.buildBindGroupEntries(this.renderPassEntry, /*forCompute=*/false);
      if (entries && this.renderPassEntry.bindGroupLayout) {
        const bindGroup = this.device.createBindGroup({
          layout: this.renderPassEntry.bindGroupLayout,
          entries,
        });
        this.renderPassEncoder.setBindGroup(0, bindGroup);
      }
    }
    this.renderPassEncoder.draw(vertexCount, instanceCount);
  }

  endRenderPass(_pass: number) {
    if (this.renderPassEncoder) {
      this.renderPassEncoder.end();
      this.renderPassEncoder = null;
      this.renderPassEntry = null;
      this.renderPassBuffers.clear();
    }
  }

  flush() {
    if (this.encoder) {
      this.device.queue.submit([this.encoder.finish()]);
      this.encoder = null;
    }
  }

  /**
   * Clear a texture to a constant color. Implemented as a tiny render pass
   * with `loadOp: 'clear'`, so the texture must have been created with a
   * color-attachment-capable format (rgba8unorm / bgra8unorm / rgba16float).
   * For non-renderable formats (r32float, rgba32float) callers should
   * dispatch a compute shader that writes the constant directly — there is
   * no portable WebGPU "clear" path for those.
   */
  clearTexture(textureHandle: number, r: number, g: number, b: number, a: number) {
    const texture = this.get(textureHandle) as GPUTexture;
    if (!texture) return;
    const encoder = this.ensureEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r, g, b, a },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
  }

  /**
   * Copy one texture to another. Both must have COPY_SRC/COPY_DST usage
   * (createTexture sets these by default), identical formats, and the same
   * size — this is a 1:1 byte-level copy, not a reformatting blit.
   */
  copyTexture(srcHandle: number, dstHandle: number) {
    const src = this.get(srcHandle) as GPUTexture;
    const dst = this.get(dstHandle) as GPUTexture;
    if (!src || !dst) return;
    const w = Math.min(src.width, dst.width);
    const h = Math.min(src.height, dst.height);
    const encoder = this.ensureEncoder();
    encoder.copyTextureToTexture(
      { texture: src },
      { texture: dst },
      [w, h, 1],
    );
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
    this._readMemory = readMemory;
    return {
      get_backend: () => this.getBackend(),
      create_shader_module: (srcPtr: number, srcLen: number) =>
        this.createShaderModule(readString(srcPtr, srcLen)),
      create_buffer: (size: number, usage: number) =>
        this.createBuffer(size, usage),
      create_texture: (w: number, h: number, format: number) =>
        this.createTexture(w, h, format),
      create_texture_3d: (w: number, h: number, d: number, format: number) =>
        this.createTexture3D(w, h, d, format),
      create_sampler: (filterMode: number, addressMode: number) =>
        this.createSampler(filterMode, addressMode),
      create_compute_pso_layout: (shader: number, entryPtr: number, entryLen: number,
                                   bindCount: number, bindPtr: number) => {
        const bindings = readBindingDecls(this.memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createComputePipelineWithLayout(shader, readString(entryPtr, entryLen), bindings);
      },
      create_render_pso_layout: (
        vsShader: number, vsPtr: number, vsLen: number,
        fsShader: number, fsPtr: number, fsLen: number, format: number,
        bindCount: number, bindPtr: number) => {
        const bindings = readBindingDecls(this.memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createRenderPipelineWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen), format, bindings);
      },
      create_instanced_render_pso_layout: (
        vsShader: number, vsPtr: number, vsLen: number,
        fsShader: number, fsPtr: number, fsLen: number, format: number,
        bindCount: number, bindPtr: number) => {
        const bindings = readBindingDecls(this.memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createInstancedRenderPipelineWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen), format, bindings);
      },
      write_buffer: (buf: number, offset: number, dataPtr: number, dataLen: number) =>
        this.writeBuffer(buf, offset, readMemory(dataPtr, dataLen)),
      begin_compute_pass: () => this.beginComputePass(),
      compute_set_pso: (pass: number, pipeline: number) =>
        this.computeSetPipeline(pass, pipeline),
      compute_set_buffer: (pass: number, buf: number, offset: number, slot: number) =>
        this.computeSetBuffer(pass, buf, offset, slot),
      compute_set_texture: (pass: number, tex: number, slot: number, access: number) =>
        this.computeSetTexture(pass, tex, slot, access),
      compute_set_sampler: (pass: number, sampler: number, slot: number) =>
        this.computeSetSampler(pass, sampler, slot),
      compute_dispatch: (pass: number, x: number, y: number, z: number) =>
        this.computeDispatch(pass, x, y, z),
      end_compute_pass: (pass: number) => this.endComputePass(pass),
      begin_render_pass: (texture: number, cr: number, cg: number, cb: number, ca: number) =>
        this.beginRenderPass(texture, cr, cg, cb, ca),
      render_set_pso: (pass: number, pipeline: number) =>
        this.renderSetPipeline(pass, pipeline),
      render_set_vertex_buffer: (pass: number, buf: number, offset: number, slot: number) =>
        this.renderSetVertexBuffer(pass, buf, offset, slot),
      render_set_buffer: (pass: number, buf: number, slot: number) =>
        this.renderSetBuffer(pass, buf, slot),
      render_draw: (pass: number, vertexCount: number, instanceCount: number) =>
        this.renderDraw(pass, vertexCount, instanceCount),
      end_render_pass: (pass: number) => this.endRenderPass(pass),
      submit: () => this.flush(),
      get_render_target: () => this.getSurfaceTexture(),
      get_render_target_width: () => this.getSurfaceWidth(),
      get_render_target_height: () => this.getSurfaceHeight(),
      release: (handle: number) => this.release(handle),
      clear_texture: (tex: number, r: number, g: number, b: number, a: number) =>
        this.clearTexture(tex, r, g, b, a),
      copy_texture: (src: number, dst: number) =>
        this.copyTexture(src, dst),
      create_instanced_render_pso_mrt_layout: (
        vsShader: number, vsPtr: number, vsLen: number,
        fsShader: number, fsPtr: number, fsLen: number,
        count: number, fmtsPtr: number,
        bindCount: number, bindPtr: number) => {
        const fmts = new Int32Array(this.memorySlice(fmtsPtr, count * 4).buffer);
        const bindings = readBindingDecls(this.memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createInstancedRenderPipelineMRTWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen),
          count, fmts, bindings);
      },
      begin_render_pass_mrt: (count: number, texPtr: number, clearPtr: number) => {
        const tex = new Int32Array(this.memorySlice(texPtr, count * 4).buffer);
        const cv = new Float32Array(this.memorySlice(clearPtr, count * 16).buffer);
        return this.beginRenderPassMRT(count, tex, cv);
      },
    };
  }

  // Slice memory into a fresh ArrayBuffer (the readMemory passed in by
  // wasm-host returns slices, but for typed-array views we need owned
  // buffers; otherwise the offsets reference WASM memory which can move
  // and align oddly).
  private memorySlice(ptr: number, len: number): Uint8Array {
    return this._readMemory ? this._readMemory(ptr, len) : new Uint8Array(0);
  }
  private _readMemory: ((ptr: number, len: number) => Uint8Array) | null = null;
}
