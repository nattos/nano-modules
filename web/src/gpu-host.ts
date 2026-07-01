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
  // True for pipelines created with WebGPU 'layout: "auto"' (the unified
  // executor.wasm's no-layout fused-chain PSO). Dispatch builds the bind
  // group from whatever slots were set, against pipeline.getBindGroupLayout(0).
  autoBindings?: boolean;
}

/// Read packed pipeline-creation-time constants from a wasm-side byte
/// buffer. Layout (matches gpu::Constants::pack in gpu.h):
///   u32 count, then per entry: u32 name_len, name bytes, f64 value.
/// All multi-byte integers are little-endian (wasm32). Returned map
/// keys match the HLSL `[[vk::constant_id]]` names, which naga
/// preserves verbatim in the WGSL `@id(N) override` declarations.
function readConstants(bytes: Uint8Array): Record<string, number> {
  if (bytes.byteLength < 4) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count === 0) return {};
  const dec = new TextDecoder();
  const out: Record<string, number> = {};
  let p = 4;
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint32(p, true); p += 4;
    const name = dec.decode(new Uint8Array(bytes.buffer, bytes.byteOffset + p, nameLen));
    p += nameLen;
    const value = view.getFloat64(p, true); p += 8;
    out[name] = value;
  }
  return out;
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
  /** The underlying WebGPU device. Exposed read-only so callers that need
   *  raw device access (e.g. the DXV decoder's native BC1 writeTexture
   *  upload) can reach it without re-plumbing it through every API. */
  readonly device: GPUDevice;
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
      // Reuse the compiled module for identical WGSL across effect INSTANCES — a
      // GPUShaderModule is immutable and `release()` never destroys it, so sharing is
      // safe and skips a re-parse. (Re-instantiating a heavy effect the playhead
      // re-enters otherwise re-compiled the same shaders from scratch.)
      let module = this.shaderModuleCache.get(source);
      if (!module) { module = this.device.createShaderModule({ code: source }); this.shaderModuleCache.set(source, module); }
      const handle = this.alloc('shader', module);
      // Stash the source alongside the handle. The constants resolver
      // uses it to translate `{NAME: value}` constants maps into the
      // `{"@id": value}` form Chromium currently requires for naga-
      // generated modules.
      this.shaderSources.set(handle, source);
      return handle;
    } catch (e) {
      console.error('[gpu] shader compile error:', e);
      return -1;
    }
  }
  private shaderSources: Map<number, string> = new Map();
  private shaderModuleCache: Map<string, GPUShaderModule> = new Map();

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
    return this.createTextureWithMips(width, height, format, 1);
  }

  /**
   * Texture with a mip chain. mip 0 is `width × height`; each
   * subsequent mip halves both dimensions (clamped to ≥1). Mip data
   * isn't generated automatically — fill levels via compute writes
   * (`computeSetTextureMip` for the storage write target) and
   * sample at any LOD via WGSL `textureSampleLevel`.
   */
  createTextureWithMips(width: number, height: number, format: number, mipCount: number): number {
    const fmt = format === 2 ? this.surfaceFormat : textureFormatFromCode(format);
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
      mipLevelCount: Math.max(1, mipCount),
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
      bindings: BindingDecl[],
      constants?: Record<string, number>): number {
    const shaderModule = this.get(shaderHandle) as GPUShaderModule;
    if (!shaderModule) return -1;
    // Reuse the COMPILED pipeline for the same (shader, entry, bindings, constants) across
    // effect instances. createComputePipeline is the heavy GPU compile (hundreds of ms per
    // shader on a fresh instance), and a pipeline is immutable + never destroyed by release(),
    // so sharing it is safe — this is what makes re-entering a heavy effect (shape_fold) cheap.
    const src = this.shaderSources.get(shaderHandle);
    const cacheKey = src !== undefined
      ? `${entryPoint} ${JSON.stringify(bindings)} ${constants ? JSON.stringify(constants) : ''} ${src}`
      : '';
    if (cacheKey) {
      const hit = this.computePipelineCache.get(cacheKey);
      if (hit) return this.alloc('compute_pipeline', hit);
    }
    const { pipelineLayout, bindGroupLayout } = this.buildLayouts(bindings, GPUShaderStage.COMPUTE);
    // Specialization constants come from C++ as a name → value map
    // (matching the HLSL `[[vk::constant_id(N)]] const T NAME = ...;`
    // declarations). The WebGPU spec lets the constants record use
    // either override names OR @id numeric strings, but Chromium
    // currently only resolves IDs reliably for naga-emitted modules,
    // so we translate name → "@id" via the WGSL we cached at module
    // creation time.
    const computeDesc: GPUProgrammableStage = { module: shaderModule, entryPoint };
    if (constants && Object.keys(constants).length > 0) {
      computeDesc.constants = this.resolveConstantsByID(shaderHandle, constants);
    }
    const pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: computeDesc,
    });
    const entry: PipelineEntry = { pipeline, bindGroupLayout, bindings };
    if (cacheKey) this.computePipelineCache.set(cacheKey, entry);
    return this.alloc('compute_pipeline', entry);
  }
  private computePipelineCache: Map<string, PipelineEntry> = new Map();

  /**
   * Compute pipeline with WebGPU-derived layout ('layout: "auto"'). Used by the
   * unified executor.wasm for fused-chain kernels: the host doesn't enumerate
   * the binding set up front (it varies with stage count) — the bind group is
   * built at dispatch from whatever slots were set (computeSet{Texture,Buffer}),
   * against the pipeline's auto layout. Mirrors the no-layout createComputePSO
   * the native Metal backend exposes. Returns -1 on compile failure (the
   * executor caches that and falls back to per-stage rendering).
   */
  createComputePipelineAuto(shaderHandle: number, entryPoint: string): number {
    const shaderModule = this.get(shaderHandle) as GPUShaderModule;
    if (!shaderModule) return -1;
    let pipeline: GPUComputePipeline;
    try {
      pipeline = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint },
      });
    } catch (e) {
      console.error('[gpu] auto compute pipeline error:', e);
      return -1;
    }
    const entry: PipelineEntry = {
      pipeline, bindGroupLayout: null, bindings: [], autoBindings: true,
    };
    return this.alloc('compute_pipeline', entry);
  }

  /**
   * Reverse of textureFormatFromCode — the format code of a live texture handle
   * (executor.wasm queries this to match delayed-wire retention textures to
   * their producer's format). -1 if the handle isn't a texture.
   */
  getTextureFormatCode(handle: number): number {
    const tex = this.getTextureByHandle(handle);
    if (!tex) return -1;
    switch (tex.format) {
      case 'bgra8unorm': return 0;
      case 'rgba8unorm': return 1;
      case 'rgba16float': return 3;
      case 'r32float': return 4;
      default: return 1;
    }
  }

  /// Translate a name-keyed constants map to an ID-keyed one by
  /// scanning the WGSL we stashed when the shader was created.
  /// Returns the original map if the WGSL isn't available (e.g.
  /// the module was created via a non-name path that didn't cache
  /// the source). Names that don't appear in the WGSL fall through
  /// unchanged so Chromium can still surface "constant not found"
  /// errors for typos.
  private nameToIdCache: Map<number, Map<string, string>> = new Map();
  private resolveConstantsByID(
      shaderHandle: number,
      constants: Record<string, number>): Record<string, number> {
    let nameMap = this.nameToIdCache.get(shaderHandle);
    if (!nameMap) {
      const wgsl = this.shaderSources.get(shaderHandle);
      if (!wgsl) return constants;
      nameMap = new Map();
      const re = /@id\(\s*(\d+)\s*\)\s+override\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(wgsl)) !== null) {
        nameMap.set(m[2], m[1]);
      }
      this.nameToIdCache.set(shaderHandle, nameMap);
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(constants)) {
      const id = nameMap.get(k);
      out[id ?? k] = v;
    }
    return out;
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
  ///
  /// `blendMode` selects the color/alpha blend equation:
  ///   0 = alpha-over (default; src*src.a + dst*(1-src.a))
  ///   1 = additive  (src*src.a + dst; alpha channel sums)
  /// Anything else falls back to alpha-over.
  createInstancedRenderPipelineWithLayout(
      vsShaderHandle: number, vsEntry: string,
      fsShaderHandle: number, fsEntry: string, format: number,
      bindings: BindingDecl[], blendMode: number = 0): number {
    const vsModule = this.get(vsShaderHandle) as GPUShaderModule;
    const fsModule = this.get(fsShaderHandle) as GPUShaderModule;
    if (!vsModule || !fsModule) return -1;
    const fmt: GPUTextureFormat = format === 2 ? this.surfaceFormat
                                                : textureFormatFromCode(format);
    const { pipelineLayout, bindGroupLayout } = this.buildLayouts(
      bindings, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const blend: GPUBlendState = blendMode === 1
      ? {
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one',       dstFactor: 'one', operation: 'add' },
        }
      : {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };
    const pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: vsModule, entryPoint: vsEntry, buffers: [] },
      fragment: {
        module: fsModule, entryPoint: fsEntry,
        targets: [{ format: fmt, blend }],
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
    this.device.queue.writeBuffer(buffer, offset, data as Uint8Array<ArrayBuffer>);
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
  private computePassTextures: Map<number, { texture: GPUTexture; access: number; mip?: number }> = new Map();
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

  /**
   * Bind a single mip level of a texture as the storage write target
   * at `slot`. The bind group entry uses a view with
   * `baseMipLevel: mip, mipLevelCount: 1` so the shader sees only
   * that mip. For multi-mip textures (dual-filter blur, custom mip
   * generation, etc.) this is required for any pass writing one mip.
   */
  computeSetTextureMip(_pass: number, texHandle: number, slot: number, access: number, mip: number) {
    const texture = this.get(texHandle) as GPUTexture;
    if (!texture) return;
    this.computePassTextures.set(slot, { texture, access, mip });
  }

  computeSetSampler(_pass: number, samplerHandle: number, slot: number) {
    const sampler = this.get(samplerHandle) as GPUSampler;
    if (!sampler) return;
    this.computePassSamplers.set(slot, sampler);
  }

  computeDispatch(_pass: number, x: number, y: number, z: number) {
    if (!this.computePassEncoder || !this.computePassEntry) return;
    // Auto-layout pipelines (executor.wasm fused kernels) build the bind group
    // from whatever slots were set, against the pipeline's derived layout.
    if (this.computePassEntry.autoBindings) {
      const autoEntries: GPUBindGroupEntry[] = [];
      for (const [slot, t] of this.computePassTextures) {
        const view = t.mip !== undefined
          ? t.texture.createView({ baseMipLevel: t.mip, mipLevelCount: 1,
                                   dimension: t.texture.dimension === '3d' ? '3d' : '2d' })
          : t.texture.createView();
        autoEntries.push({ binding: slot, resource: view });
      }
      for (const [slot, buffer] of this.computePassBuffers) {
        autoEntries.push({ binding: slot, resource: { buffer } });
      }
      for (const [slot, sampler] of this.computePassSamplers) {
        autoEntries.push({ binding: slot, resource: sampler });
      }
      autoEntries.sort((a, b) => a.binding - b.binding);
      const bindGroup = this.device.createBindGroup({
        layout: (this.computePassEntry.pipeline as GPUComputePipeline).getBindGroupLayout(0),
        entries: autoEntries,
      });
      this.computePassEncoder.setBindGroup(0, bindGroup);
      this.computePassEncoder.dispatchWorkgroups(x, y, z);
      return;
    }
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
        // If a mip level was explicitly set (via setTextureMip),
        // create a view restricted to that one mip — required for any
        // pass writing a single mip of a multi-mip texture. Otherwise
        // the default view spans the texture's full mip chain (so
        // shaders can sample at any LOD via textureSampleLevel).
        if (tex.mip !== undefined) {
          return tex.texture.createView({
            baseMipLevel: tex.mip,
            mipLevelCount: 1,
            dimension: tex.texture.dimension === '3d' ? '3d' : '2d',
          });
        }
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
   * Begin a render pass that LOADS the existing texture content instead
   * of clearing. Useful when an earlier compute pass pre-filled the
   * target (e.g. tex_in × input_alpha for the particle compositor) and
   * the raster pass should blend on top of that content.
   */
  beginRenderPassLoad(textureHandle: number): number {
    const texture = this.get(textureHandle) as GPUTexture;
    if (!texture) return -1;

    const encoder = this.ensureEncoder();
    this.renderPassEncoder = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        loadOp: 'load',
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
    // Capture readMemory in a CLOSURE local to this buildImports call
    // — every handler in the returned imports record reads through
    // `memorySlice` below, which always sees THIS WasmHost's wasm
    // memory regardless of which other WasmHost calls buildImports
    // later. Previously we stored readMemory on `this._readMemory`
    // (shared across all WasmHosts), so when the IDE held two
    // WasmHosts (e.g. testonly + nano after a nano HMR), the LAST
    // host to instantiate would overwrite _readMemory and the other
    // host's gpu imports would read zeros from the wrong memory at
    // its own offsets — manifesting as PSO bindings packed into all
    // {slot:0,kind:0} when they came back through the import.
    const memorySlice = (ptr: number, len: number): Uint8Array => readMemory(ptr, len);
    return {
      get_backend: () => this.getBackend(),
      // Effects no longer carry raw shader source — they register SPIR-V via
      // state::registerShaderSPV and resolve it with
      // create_shader_module_named (overridden on the WasmHost). The raw
      // create_shader_module import was retired; the createShaderModule method
      // remains as the internal SPV→WGSL→module primitive.
      create_buffer: (size: number, usage: number) =>
        this.createBuffer(size, usage),
      create_texture: (w: number, h: number, format: number) =>
        this.createTexture(w, h, format),
      create_texture_mips: (w: number, h: number, format: number, mipCount: number) =>
        this.createTextureWithMips(w, h, format, mipCount),
      create_texture_3d: (w: number, h: number, d: number, format: number) =>
        this.createTexture3D(w, h, d, format),
      create_sampler: (filterMode: number, addressMode: number) =>
        this.createSampler(filterMode, addressMode),
      create_compute_pso_layout: (shader: number, entryPtr: number, entryLen: number,
                                   bindCount: number, bindPtr: number) => {
        const bindings = readBindingDecls(memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createComputePipelineWithLayout(shader, readString(entryPtr, entryLen), bindings);
      },
      create_compute_pso_v2: (shader: number, entryPtr: number, entryLen: number,
                              bindCount: number, bindPtr: number,
                              constsPtr: number, constsLen: number) => {
        const bindings = readBindingDecls(memorySlice(bindPtr, bindCount * 16), bindCount);
        const constants = constsLen > 0
            ? readConstants(memorySlice(constsPtr, constsLen))
            : undefined;
        return this.createComputePipelineWithLayout(
            shader, readString(entryPtr, entryLen), bindings, constants);
      },
      create_render_pso_layout: (
        vsShader: number, vsPtr: number, vsLen: number,
        fsShader: number, fsPtr: number, fsLen: number, format: number,
        bindCount: number, bindPtr: number) => {
        const bindings = readBindingDecls(memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createRenderPipelineWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen), format, bindings);
      },
      create_instanced_render_pso_layout: (
        vsShader: number, vsPtr: number, vsLen: number,
        fsShader: number, fsPtr: number, fsLen: number, format: number,
        bindCount: number, bindPtr: number) => {
        const bindings = readBindingDecls(memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createInstancedRenderPipelineWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen), format, bindings);
      },
      create_instanced_render_pso_blend_layout: (
        vsShader: number, vsPtr: number, vsLen: number,
        fsShader: number, fsPtr: number, fsLen: number, format: number,
        bindCount: number, bindPtr: number, blendMode: number) => {
        const bindings = readBindingDecls(memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createInstancedRenderPipelineWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen), format, bindings, blendMode);
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
      compute_set_texture_mip: (pass: number, tex: number, slot: number, access: number, mip: number) =>
        this.computeSetTextureMip(pass, tex, slot, access, mip),
      compute_set_sampler: (pass: number, sampler: number, slot: number) =>
        this.computeSetSampler(pass, sampler, slot),
      compute_dispatch: (pass: number, x: number, y: number, z: number) =>
        this.computeDispatch(pass, x, y, z),
      end_compute_pass: (pass: number) => this.endComputePass(pass),
      begin_render_pass: (texture: number, cr: number, cg: number, cb: number, ca: number) =>
        this.beginRenderPass(texture, cr, cg, cb, ca),
      begin_render_pass_load: (texture: number) =>
        this.beginRenderPassLoad(texture),
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
        const fmts = new Int32Array(memorySlice(fmtsPtr, count * 4).buffer);
        const bindings = readBindingDecls(memorySlice(bindPtr, bindCount * 16), bindCount);
        return this.createInstancedRenderPipelineMRTWithLayout(
          vsShader, readString(vsPtr, vsLen),
          fsShader, readString(fsPtr, fsLen),
          count, fmts, bindings);
      },
      begin_render_pass_mrt: (count: number, texPtr: number, clearPtr: number) => {
        const tex = new Int32Array(memorySlice(texPtr, count * 4).buffer);
        const cv = new Float32Array(memorySlice(clearPtr, count * 16).buffer);
        return this.beginRenderPassMRT(count, tex, cv);
      },
    };
  }

}
