/**
 * ImageFrameSource — a still image masquerading as a 1-frame video source.
 *
 * Lets the arrangement treat images exactly like videos through the same cache /
 * playback path: one frame, decoded via createImageBitmap and uploaded into the
 * GPUHost texture on decode(). The clip spans whatever length the caller gives
 * it; the pump always pulls frame 0.
 */

import { GPUHost } from '../gpu-host';
import type { FrameSource } from './frame-source';

export class ImageFrameSource implements FrameSource {
  readonly frameCount = 1;
  readonly width: number;
  readonly height: number;
  readonly formatCode = 1;          // rgba8unorm (matches GPUHost.createTexture code)
  readonly codec: string;
  readonly fps = 1;
  readonly streaming = false;

  private gpuHost: GPUHost;
  private device: GPUDevice;
  private bitmap: ImageBitmap | null;

  private constructor(gpuHost: GPUHost, bitmap: ImageBitmap, type: string) {
    this.gpuHost = gpuHost;
    this.device = gpuHost.device;
    this.bitmap = bitmap;
    this.width = bitmap.width;
    this.height = bitmap.height;
    this.codec = `image:${type || 'unknown'}`;
  }

  static async create(gpuHost: GPUHost, blob: Blob): Promise<ImageFrameSource> {
    const bitmap = await createImageBitmap(blob);
    if (!bitmap.width || !bitmap.height) {
      bitmap.close();
      throw new Error('image has no decodable dimensions');
    }
    return new ImageFrameSource(gpuHost, bitmap, blob.type);
  }

  async decode(_idx: number, outTexHandle: number): Promise<void> {
    if (!this.bitmap) throw new Error('image source disposed');
    const tex = this.gpuHost.getTextureByHandle(outTexHandle);
    if (!tex) throw new Error(`output texture handle ${outTexHandle} not found`);
    this.device.queue.copyExternalImageToTexture(
      { source: this.bitmap, flipY: false },
      { texture: tex },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );
  }

  dispose(): void {
    this.bitmap?.close();
    this.bitmap = null;
  }
}
