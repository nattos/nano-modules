/**
 * DxvDecoder — TS host wrapper around the dxv_decoder WASM service module.
 *
 * Decode path (single, native): the WASM module owns the QuickTime atom
 * walk and the DXV3 DXT1 LZ decompression. It returns raw BC1 bytes; this
 * wrapper uploads them straight into a `bc1-rgba-unorm` texture (via
 * device.queue.writeTexture — the GPU does BC1 decode in hardware at
 * sample time), then runs a one-pass compute blit into the caller's
 * `rgba8unorm` output texture.
 *
 * Requires the `texture-compression-bc` WebGPU feature. This is universal
 * on desktop browsers; we don't ship a fallback.
 *
 * Usage:
 *   const dec = await DxvDecoder.create(gpuHost);
 *   const info = await dec.open(blobBytesSource(file));
 *   const tex = gpuHost.createTexture(info.width, info.height, 1);
 *   await dec.decode(0, tex);
 *   const pixels = await gpuHost.readbackTexture(tex, info.width, info.height);
 */

import { WasmHost } from './wasm-host';
import { GPUHost } from './gpu-host';

export interface BytesSource {
  readonly size: number;
  slice(offset: number, length: number): Promise<ArrayBuffer>;
}

export function arrayBufferBytesSource(buf: ArrayBuffer): BytesSource {
  return {
    size: buf.byteLength,
    async slice(offset, length) {
      return buf.slice(offset, offset + length);
    },
  };
}

export function blobBytesSource(blob: Blob): BytesSource {
  return {
    size: blob.size,
    async slice(offset, length) {
      return await blob.slice(offset, offset + length).arrayBuffer();
    },
  };
}

export interface DxvVideoInfo {
  width: number;
  height: number;
  /** Codec FourCC packed as LE32 of the ASCII bytes (so "DXD3" → 0x33445844). */
  fourcc: number;
  /** Codec FourCC as a 4-char string ("DXD3", "DXDA", ...). */
  fourccStr: string;
  frameCount: number;
}

interface DxvExports {
  memory: WebAssembly.Memory;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  dxv_alloc: (n: number) => number;
  dxv_free: (p: number) => void;
  dxv_parse_container: (ptr: number, len: number) => number;
  dxv_frame_count: () => number;
  dxv_video_width: () => number;
  dxv_video_height: () => number;
  dxv_video_fourcc: () => number;
  dxv_get_frame_offset: (idx: number) => bigint;
  dxv_get_frame_size: (idx: number) => number;
  dxv_lz_decompress_frame: (payloadPtr: number, payloadLen: number) => number;
}

// 'moov' BE u32
const ATOM_MOOV = 0x6d6f6f76;

// One-compute-pass blit: load the BC1 sample (the GPU hardware-decodes
// to RGBA on read) and store into the rgba8unorm output texture. Inlined
// here because it is trivial and avoids dragging the HLSL/naga build
// pipeline into a wasm module that is otherwise pure CPU.
const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(dst);
  if (gid.x >= dim.x || gid.y >= dim.y) { return; }
  let c = textureLoad(src, vec2<i32>(gid.xy), 0);
  textureStore(dst, vec2<i32>(gid.xy), c);
}
`;

export class DxvDecoder {
  private wasmHost: WasmHost;
  private gpuHost: GPUHost;
  private device: GPUDevice;
  private exports!: DxvExports;
  private source: BytesSource | null = null;
  private info: DxvVideoInfo | null = null;

  // Per-frame compressed-payload scratch buffer in wasm linear memory.
  // Sized to the max frame size on open(), reused across decodes.
  private payloadBufferPtr = 0;
  private payloadBufferCap = 0;

  // JS-side mirror of the WASM frame table so decode() doesn't have to
  // round-trip through dxv_get_frame_offset / dxv_get_frame_size on every
  // call. Offsets stored as Number — safe up to ~9 PB (2^53 bytes).
  private frameOffsets: number[] = [];
  private frameSizes: number[] = [];

  // BC1 staging texture (sized to video dimensions, allocated lazily on
  // first decode). The hardware BC1 unit decodes at sample time, so the
  // blit pass can read this as a regular `texture_2d<f32>`.
  private bc1Tex: GPUTexture | null = null;
  private bc1TexW = 0;
  private bc1TexH = 0;

  // Blit pipeline (BC1 → rgba8unorm). Lazily compiled on first decode.
  private blitPipeline: GPUComputePipeline | null = null;
  private blitLayout: GPUBindGroupLayout | null = null;

  private constructor(wasmHost: WasmHost, gpuHost: GPUHost) {
    this.wasmHost = wasmHost;
    this.gpuHost = gpuHost;
    this.device = gpuHost.device;
  }

  static async create(gpuHost: GPUHost,
                      wasmUrl: string = 'wasm/dxv_decoder.wasm'): Promise<DxvDecoder> {
    if (!gpuHost.device.features.has('texture-compression-bc')) {
      throw new Error(
        "DxvDecoder requires the 'texture-compression-bc' WebGPU feature. "
        + 'Request it when calling adapter.requestDevice({ requiredFeatures: ["texture-compression-bc"] }).');
    }
    const wasmHost = new WasmHost();
    wasmHost.gpuHost = gpuHost;
    await wasmHost.load(wasmUrl);
    const dec = new DxvDecoder(wasmHost, gpuHost);
    const svc = wasmHost.activateServiceModule();
    dec.exports = svc.instance.exports as unknown as DxvExports;
    return dec;
  }

  /**
   * Build the frame table from the container's moov atom. Reads only the
   * top-level box headers + the moov body from `source` — never touches
   * mdat, so this stays cheap on 1 GB+ files.
   */
  async open(source: BytesSource): Promise<DxvVideoInfo> {
    this.source = source;
    const moovRange = await findMoov(source);
    const moovBuf = await source.slice(moovRange.offset, moovRange.size);
    const moov = new Uint8Array(moovBuf);

    const ptr = this.exports.dxv_alloc(moov.length);
    if (!ptr) throw new Error('wasm dxv_alloc failed for moov');
    try {
      new Uint8Array(this.exports.memory.buffer, ptr, moov.length).set(moov);
      const frameCount = this.exports.dxv_parse_container(ptr, moov.length);
      if (frameCount < 0) {
        throw new Error(`dxv_parse_container failed (rc=${frameCount})`);
      }

      this.frameOffsets = new Array(frameCount);
      this.frameSizes = new Array(frameCount);
      let maxSize = 0;
      for (let i = 0; i < frameCount; i++) {
        const off = Number(this.exports.dxv_get_frame_offset(i));
        const sz = this.exports.dxv_get_frame_size(i);
        this.frameOffsets[i] = off;
        this.frameSizes[i] = sz;
        if (sz > maxSize) maxSize = sz;
      }

      const fourcc = this.exports.dxv_video_fourcc();
      this.info = {
        width: this.exports.dxv_video_width(),
        height: this.exports.dxv_video_height(),
        fourcc,
        fourccStr: fourCCToString(fourcc),
        frameCount,
      };

      this.ensurePayloadCapacity(maxSize);
      return this.info;
    } finally {
      this.exports.dxv_free(ptr);
    }
  }

  /** Decode frame `idx` into the given RGBA8 output texture (gpu-host handle). */
  async decode(idx: number, outTexHandle: number): Promise<void> {
    if (!this.source || !this.info) throw new Error('DxvDecoder.open() not called');
    if (idx < 0 || idx >= this.info.frameCount) {
      throw new Error(`frame index ${idx} out of range [0, ${this.info.frameCount})`);
    }
    const offset = this.frameOffsets[idx];
    const size = this.frameSizes[idx];

    const payload = new Uint8Array(await this.source.slice(offset, size));
    this.ensurePayloadCapacity(size);
    new Uint8Array(this.exports.memory.buffer, this.payloadBufferPtr, size).set(payload);

    const decodedPtr = this.exports.dxv_lz_decompress_frame(this.payloadBufferPtr, size);
    if (!decodedPtr) {
      throw new Error(`dxv_lz_decompress_frame failed for frame ${idx}`);
    }

    const { width, height } = this.info;
    const blocksX = Math.ceil(width / 4);
    const blocksY = Math.ceil(height / 4);
    const bc1Bytes = blocksX * blocksY * 8;

    // Wrap the wasm-side scratch buffer as a view; pass straight to
    // writeTexture (one copy from wasm memory into the BC1 texture).
    const bcBytes = new Uint8Array(this.exports.memory.buffer, decodedPtr, bc1Bytes);
    const bc1Tex = this.ensureBc1Texture(width, height);
    this.device.queue.writeTexture(
      { texture: bc1Tex },
      bcBytes,
      { offset: 0, bytesPerRow: blocksX * 8, rowsPerImage: blocksY },
      { width, height, depthOrArrayLayers: 1 },
    );

    // Hardware BC1 decode happens implicitly inside textureLoad in the
    // blit shader; the output texture ends up rgba8unorm.
    const outTex = this.gpuHost.getTextureByHandle(outTexHandle);
    if (!outTex) {
      throw new Error(`output texture handle ${outTexHandle} not found in GPUHost`);
    }
    this.ensureBlitPipeline();
    const bg = this.device.createBindGroup({
      layout: this.blitLayout!,
      entries: [
        { binding: 0, resource: bc1Tex.createView() },
        { binding: 1, resource: outTex.createView() },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Cached metadata. Throws if open() wasn't called. */
  get videoInfo(): DxvVideoInfo {
    if (!this.info) throw new Error('DxvDecoder.open() not called');
    return this.info;
  }

  /** Raw frame offset (absolute file byte position). Useful for diagnostics. */
  getFrameOffset(idx: number): number { return this.frameOffsets[idx]; }
  getFrameSize(idx: number): number { return this.frameSizes[idx]; }

  dispose(): void {
    if (this.payloadBufferPtr) {
      this.exports.dxv_free(this.payloadBufferPtr);
      this.payloadBufferPtr = 0;
      this.payloadBufferCap = 0;
    }
    this.bc1Tex?.destroy();
    this.bc1Tex = null;
    this.bc1TexW = this.bc1TexH = 0;
  }

  private ensurePayloadCapacity(needBytes: number) {
    if (this.payloadBufferCap >= needBytes) return;
    if (this.payloadBufferPtr) this.exports.dxv_free(this.payloadBufferPtr);
    this.payloadBufferPtr = this.exports.dxv_alloc(needBytes);
    if (!this.payloadBufferPtr) throw new Error(`wasm dxv_alloc(${needBytes}) failed`);
    this.payloadBufferCap = needBytes;
  }

  private ensureBc1Texture(width: number, height: number): GPUTexture {
    if (this.bc1Tex && this.bc1TexW === width && this.bc1TexH === height) {
      return this.bc1Tex;
    }
    this.bc1Tex?.destroy();
    this.bc1Tex = this.device.createTexture({
      size: [width, height, 1],
      format: 'bc1-rgba-unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.bc1TexW = width;
    this.bc1TexH = height;
    return this.bc1Tex;
  }

  private ensureBlitPipeline(): void {
    if (this.blitPipeline) return;
    const module = this.device.createShaderModule({ code: BLIT_WGSL });
    this.blitLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { format: 'rgba8unorm', access: 'write-only', viewDimension: '2d' },
        },
      ],
    });
    this.blitPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      compute: { module, entryPoint: 'main' },
    });
  }
}

/**
 * Walk top-level ISO-BMFF boxes in `source` and return the byte range of the
 * first `moov`. Reads only 8 or 16 bytes per box (the header) — skipping
 * past mdat is essentially free even for multi-gigabyte files.
 */
async function findMoov(source: BytesSource): Promise<{ offset: number; size: number }> {
  let pos = 0;
  while (pos < source.size) {
    const remaining = source.size - pos;
    if (remaining < 8) break;
    const hdrBuf = await source.slice(pos, Math.min(16, remaining));
    const hdr = new DataView(hdrBuf);
    let size = hdr.getUint32(0);
    const type = hdr.getUint32(4);
    if (size === 1) {
      if (hdr.byteLength < 16) break;
      const hi = hdr.getUint32(8);
      const lo = hdr.getUint32(12);
      size = hi * 0x100000000 + lo;
    } else if (size === 0) {
      size = source.size - pos;
    }
    if (type === ATOM_MOOV) return { offset: pos, size };
    if (size < 8 || pos + size > source.size) break;
    pos += size;
  }
  throw new Error('moov atom not found in container');
}

function fourCCToString(le32: number): string {
  return String.fromCharCode(
    le32 & 0xff,
    (le32 >>> 8) & 0xff,
    (le32 >>> 16) & 0xff,
    (le32 >>> 24) & 0xff,
  );
}
