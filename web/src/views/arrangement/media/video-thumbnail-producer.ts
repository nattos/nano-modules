/**
 * VideoThumbnailProducer — the real `ThumbnailProducer` that decodes frames via
 * the existing video playback service and downscales them to thumbnails.
 *
 * It reuses `VideoPlaybackService.pull()` (which owns decode, caching, and
 * access-pattern profiling) and reads the resulting GPU texture back to a small
 * `ImageBitmap`. Clip handles are opened lazily and memoized per sourceKey.
 * Verified manually with a real video in the thumbnail testbed; the pure cache
 * logic is unit-tested separately.
 */

import type { ThumbnailProducer } from './thumbnail-cache';
import type { VideoPlaybackService, ClipHandle } from '../../../video/playback-service';
import type { GPUHost } from '../../../gpu-host';

export class VideoThumbnailProducer implements ThumbnailProducer<ImageBitmap> {
  private clips = new Map<string, Promise<ClipHandle>>();

  constructor(
    private service: VideoPlaybackService,
    private gpuHost: GPUHost,
    /** Open a clip handle for a sourceKey (resolves the media file handle). */
    private openClip: (sourceKey: string) => Promise<ClipHandle>,
    private thumbW = 160,
    private thumbH = 90,
  ) {}

  private clipFor(sourceKey: string): Promise<ClipHandle> {
    let p = this.clips.get(sourceKey);
    if (!p) {
      p = this.openClip(sourceKey);
      this.clips.set(sourceKey, p);
    }
    return p;
  }

  async produce(sourceKey: string, frame: number, signal?: AbortSignal): Promise<ImageBitmap> {
    const clip = await this.clipFor(sourceKey);
    const handle = await this.service.pull(clip, frame);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const tex = this.gpuHost.getTextureByHandle(handle);
    if (!tex) throw new Error(`thumbnail: no texture for ${sourceKey}#${frame}`);
    const w = tex.width;
    const h = tex.height;
    const rgba = await this.gpuHost.readbackTexture(handle, w, h);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
    return createImageBitmap(img, {
      resizeWidth: this.thumbW,
      resizeHeight: this.thumbH,
      resizeQuality: 'medium',
    });
  }

  /** Decode a frame for the LARGE clip-details preview: same pull + readback, but kept
   *  near native resolution (capped to `maxDim` on the long edge, aspect preserved) so
   *  it isn't the blurry 160×90 thumbnail. Not cached here — the caller memoizes. */
  async producePreview(sourceKey: string, frame: number, maxDim = 720, signal?: AbortSignal): Promise<ImageBitmap> {
    const clip = await this.clipFor(sourceKey);
    const handle = await this.service.pull(clip, frame);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const tex = this.gpuHost.getTextureByHandle(handle);
    if (!tex) throw new Error(`preview: no texture for ${sourceKey}#${frame}`);
    const w = tex.width, h = tex.height;
    const rgba = await this.gpuHost.readbackTexture(handle, w, h);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
    const scale = Math.min(1, maxDim / Math.max(1, w, h));
    if (scale >= 1) return createImageBitmap(img); // already small enough → native size
    return createImageBitmap(img, {
      resizeWidth: Math.max(1, Math.round(w * scale)),
      resizeHeight: Math.max(1, Math.round(h * scale)),
      resizeQuality: 'high',
    });
  }

  /** Drop memoized clip handles (e.g. on workspace unmount). */
  reset() {
    this.clips.clear();
  }
}
