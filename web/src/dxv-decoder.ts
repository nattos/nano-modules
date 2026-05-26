/**
 * DxvDecoder — TS host wrapper around the dxv_decoder WASM service module.
 *
 * The module owns the container atom walker, the DXV3 LZ decompressor, and
 * the BC1 → RGBA8 compute pipeline. This wrapper feeds it bytes from a
 * `BytesSource` (Blob, ArrayBuffer, FileSystemFileHandle), shuttles the
 * compressed frame payload through WASM linear memory, and dispatches the
 * decode into a caller-supplied output texture.
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
  dxv_decode_frame: (payloadPtr: number, payloadLen: number, outTex: number) => number;
}

// 'moov' BE u32
const ATOM_MOOV = 0x6d6f6f76;

export class DxvDecoder {
  private wasmHost: WasmHost;
  private gpuHost: GPUHost;
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

  private constructor(wasmHost: WasmHost, gpuHost: GPUHost) {
    this.wasmHost = wasmHost;
    this.gpuHost = gpuHost;
  }

  static async create(gpuHost: GPUHost,
                      wasmUrl: string = 'wasm/dxv_decoder.wasm'): Promise<DxvDecoder> {
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

    const rc = this.exports.dxv_decode_frame(this.payloadBufferPtr, size, outTexHandle);
    if (rc !== 0) {
      throw new Error(`dxv_decode_frame failed for frame ${idx}: rc=${rc}`);
    }
  }

  /** Cached metadata. Throws if open() wasn't called. */
  get videoInfo(): DxvVideoInfo {
    if (!this.info) throw new Error('DxvDecoder.open() not called');
    return this.info;
  }

  /** Raw frame offset (absolute file byte position). Useful for diagnostics. */
  getFrameOffset(idx: number): number {
    return this.frameOffsets[idx];
  }
  getFrameSize(idx: number): number {
    return this.frameSizes[idx];
  }

  dispose(): void {
    if (this.payloadBufferPtr) {
      this.exports.dxv_free(this.payloadBufferPtr);
      this.payloadBufferPtr = 0;
      this.payloadBufferCap = 0;
    }
  }

  private ensurePayloadCapacity(needBytes: number) {
    if (this.payloadBufferCap >= needBytes) return;
    if (this.payloadBufferPtr) this.exports.dxv_free(this.payloadBufferPtr);
    this.payloadBufferPtr = this.exports.dxv_alloc(needBytes);
    if (!this.payloadBufferPtr) throw new Error(`wasm dxv_alloc(${needBytes}) failed`);
    this.payloadBufferCap = needBytes;
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
      // BMFF spec lays out the 64-bit size as a single BE u64 immediately
      // after the 8-byte header.
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
  // dxv_video_fourcc returns the LE32 of the ASCII bytes, i.e. the byte
  // at file offset N becomes bit (N*8) of the result. So extracting
  // bytes 0..3 from the LSB gives the ASCII chars in order.
  return String.fromCharCode(
    le32 & 0xff,
    (le32 >>> 8) & 0xff,
    (le32 >>> 16) & 0xff,
    (le32 >>> 24) & 0xff,
  );
}
