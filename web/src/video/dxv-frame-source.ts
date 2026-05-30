/**
 * DxvFrameSource — FrameSource backed by the existing DxvDecoder.
 *
 * Thin adapter: the decoder already takes (frameIdx, outTexHandle) and
 * decodes into the caller's texture via the BC1 hardware path. We just
 * surface its metadata + lifecycle behind the codec-agnostic interface.
 */

import { DxvDecoder, type BytesSource, type DxvVideoInfo } from '../dxv-decoder';
import { GPUHost } from '../gpu-host';
import type { FrameSource } from './frame-source';

/** Thrown by `DxvFrameSource.create` when the container parses but isn't a
 *  DXV stream (e.g. an h264 .mp4). The playback service catches this and
 *  falls back to the browser-decoder path. */
export class NotDxvError extends Error {
  constructor(public readonly fourcc: string) {
    super(`not a DXV stream (codec '${fourcc}')`);
    this.name = 'NotDxvError';
  }
}

export class DxvFrameSource implements FrameSource {
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  // DXV is random-access (every frame independent), so playback rate is
  // purely cosmetic — any value avoids black frames. The container's true
  // rate isn't parsed yet; 30 is a sensible default.
  readonly fps: number = 30;
  readonly formatCode: number = 1;     // rgba8unorm (matches GPUHost.createTexture code)
  readonly codec: string;
  readonly streaming = false;          // random-access: every frame independent

  private decoder: DxvDecoder;

  private constructor(decoder: DxvDecoder, info: DxvVideoInfo) {
    this.decoder = decoder;
    this.frameCount = info.frameCount;
    this.width = info.width;
    this.height = info.height;
    this.codec = `DXV-${info.fourccStr}`;   // e.g. "DXV-DXD3"
  }

  static async create(
    gpuHost: GPUHost,
    source: BytesSource,
    wasmUrl?: string,
  ): Promise<DxvFrameSource> {
    const decoder = await DxvDecoder.create(gpuHost, wasmUrl);
    const info = await decoder.open(source);
    // The container parses for any ISO-BMFF, but only DXV streams carry a
    // DXV codec tag (DXD3 / DXDI / DXDA …). Reject everything else so the
    // service routes it to the browser-decoder path instead.
    if (!/^DX/i.test(info.fourccStr)) {
      decoder.dispose();
      throw new NotDxvError(info.fourccStr);
    }
    return new DxvFrameSource(decoder, info);
  }

  async decode(idx: number, outTexHandle: number): Promise<void> {
    await this.decoder.decode(idx, outTexHandle);
  }

  dispose(): void {
    this.decoder.dispose();
  }
}
