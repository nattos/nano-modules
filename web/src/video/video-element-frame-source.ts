/**
 * VideoElementFrameSource — FrameSource backed by a hidden <video> element
 * + the browser's own decoders (h264/HEVC/VP9/AV1 — whatever the host
 * supports). Frames are pulled by seeking the element and copying the
 * current frame into the caller's GPU texture via
 * `device.queue.copyExternalImageToTexture`, so the output is the same
 * RGBA8 GPUTexture handle the DXV path produces. Same FrameSource
 * interface — the playback service can't tell the codecs apart.
 *
 * Random access is by seek-and-await: each `decode(idx)` sets
 * `currentTime` and waits for `seeked`. That's genuinely slow for
 * long-GOP codecs (tens of ms per seek) — exactly the SlowSeek cost the
 * profiling + caching layer exists to hide.
 *
 * Main-thread only (uses `document` / HTMLVideoElement). A worker-side
 * deployment would swap this for a WebCodecs `VideoDecoder` + demuxer;
 * the FrameSource contract is identical either way.
 */

import { GPUHost } from '../gpu-host';
import type { FrameSource } from './frame-source';

export interface VideoElementOptions {
  /** Frames-per-second used to map frame index ↔ media time. The
   *  `<video>` API exposes duration but not an exact frame count or
   *  rate, so we assume one (default 30) and derive frameCount from
   *  duration. Playback stays internally consistent; pass the real rate
   *  if you know it for frame-accurate indexing. */
  fps?: number;
}

export class VideoElementFrameSource implements FrameSource {
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly formatCode = 1;          // rgba8unorm (matches GPUHost.createTexture code)
  readonly codec: string;

  private gpuHost: GPUHost;
  private device: GPUDevice;
  private video: HTMLVideoElement;
  private objectUrl: string;
  private fps: number;

  private constructor(
    gpuHost: GPUHost, video: HTMLVideoElement, objectUrl: string,
    fps: number, codec: string,
  ) {
    this.gpuHost = gpuHost;
    this.device = gpuHost.device;
    this.video = video;
    this.objectUrl = objectUrl;
    this.fps = fps;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.frameCount = Math.max(1, Math.round(video.duration * fps));
    this.codec = `video:${codec || 'unknown'}`;
  }

  static async create(
    gpuHost: GPUHost, blob: Blob, opts?: VideoElementOptions,
  ): Promise<VideoElementFrameSource> {
    if (typeof document === 'undefined') {
      throw new Error('VideoElementFrameSource requires a DOM (main thread)');
    }
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    try {
      await new Promise<void>((resolve, reject) => {
        const onMeta = () => {
          cleanup();
          // Guard against containers the browser opens but can't decode
          // (zero dimensions / NaN duration).
          if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
            reject(new Error('video has no decodable dimensions/duration'));
          } else {
            resolve();
          }
        };
        const onErr = () => {
          cleanup();
          reject(new Error(`<video> load failed (code ${video.error?.code ?? '?'})`));
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onMeta);
          video.removeEventListener('error', onErr);
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('error', onErr);
        video.src = objectUrl;
      });
    } catch (err) {
      URL.revokeObjectURL(objectUrl);
      throw err;
    }

    video.pause();
    const fps = opts?.fps ?? 30;
    return new VideoElementFrameSource(gpuHost, video, objectUrl, fps, blob.type);
  }

  async decode(idx: number, outTexHandle: number): Promise<void> {
    // Land just inside the target frame's cell so rounding doesn't pull
    // the previous frame at exact boundaries.
    const t = Math.min(
      Math.max(0, this.video.duration - 1e-3),
      idx / this.fps + 0.5 / this.fps,
    );
    await this.seekTo(t);
    const tex = this.gpuHost.getTextureByHandle(outTexHandle);
    if (!tex) throw new Error(`output texture handle ${outTexHandle} not found`);
    this.device.queue.copyExternalImageToTexture(
      { source: this.video, flipY: false },
      { texture: tex },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );
  }

  private seekTo(t: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (Math.abs(this.video.currentTime - t) < 1e-6 && this.video.readyState >= 2) {
        // Already there with a frame ready — no seek event will fire.
        resolve();
        return;
      }
      const onSeeked = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error('seek failed')); };
      const cleanup = () => {
        this.video.removeEventListener('seeked', onSeeked);
        this.video.removeEventListener('error', onErr);
      };
      this.video.addEventListener('seeked', onSeeked);
      this.video.addEventListener('error', onErr);
      this.video.currentTime = t;
    });
  }

  dispose(): void {
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch { /* ignore */ }
    URL.revokeObjectURL(this.objectUrl);
  }
}
