/**
 * VideoElementFrameSource — FrameSource backed by a hidden <video> element
 * + the browser's own decoders (h264/HEVC/VP9/AV1 — whatever the host
 * supports). Each frame is copied into the caller's GPU texture via
 * `device.queue.copyExternalImageToTexture`, so the output is the same
 * RGBA8 GPUTexture handle the DXV path produces.
 *
 * Two decode strategies, picked per source:
 *   - **seekable** (`streaming = false`): frequent-keyframe clips seek
 *     cleanly, so `decode(idx)` seeks to the frame. Supports random
 *     access / scrubbing, and the service caches + reads ahead normally.
 *   - **streaming** (`streaming = true`): sparse-keyframe clips (e.g. one
 *     keyframe per ~10s) return black when seeking to a non-keyframe, so
 *     we let the element play + loop natively and sample the current
 *     frame (`idx` ignored). The service bypasses cache + read-ahead.
 *
 * Which one is decided by a quick seek probe at open (or a persisted
 * verdict from the source profile). Main-thread only (uses `document`).
 */

import { GPUHost } from '../gpu-host';
import type { FrameSource } from './frame-source';

export interface VideoElementOptions {
  /** Frames-per-second override. If omitted, measured via rVFC at load. */
  fps?: number;
  /** Decode-strategy hint from a persisted source profile: `true` forces
   *  streaming (play-forward), `false` forces seekable. If omitted, the
   *  source is probed at open. */
  streaming?: boolean;
}

/** Cap on a single seek's wait in the decode path. */
const SEEK_TIMEOUT_MS = 300;
/** Cap for the open-time probe. Must match the playback budget, NOT be
 *  generous: given hundreds of ms a browser will happily decode-forward
 *  100+ frames from a lone keyframe and return a real frame, making a
 *  sparse-keyframe clip *look* seekable — yet real-time scrubbing (which
 *  lives within ~SEEK_TIMEOUT_MS per frame) gets black there. Probing
 *  under the same tight budget predicts what playback will actually see. */
const PROBE_SEEK_TIMEOUT_MS = SEEK_TIMEOUT_MS;
/** Mean luminance (0–255) below which a probe frame counts as "black". */
const PROBE_BLACK_THRESH = 6;

export class VideoElementFrameSource implements FrameSource {
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly formatCode = 1;          // rgba8unorm (matches GPUHost.createTexture code)
  readonly codec: string;
  readonly fps: number;
  readonly streaming: boolean;

  private gpuHost: GPUHost;
  private device: GPUDevice;
  private video: HTMLVideoElement;
  private objectUrl: string;

  private constructor(
    gpuHost: GPUHost, video: HTMLVideoElement, objectUrl: string,
    fps: number, codec: string, streaming: boolean,
  ) {
    this.gpuHost = gpuHost;
    this.device = gpuHost.device;
    this.video = video;
    this.objectUrl = objectUrl;
    this.fps = fps;
    this.streaming = streaming;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.frameCount = Math.max(1, Math.round(video.duration * fps));
    this.codec = `video:${codec || 'unknown'}${streaming ? ' (stream)' : ' (seek)'}`;
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
    // Measure the real frame rate (rVFC plays a few frames) before
    // deciding strategy, so the frame↔time mapping is accurate.
    const fps = opts?.fps ?? await measureFps(video);
    // Decide seekable vs streaming: use the persisted hint if we have one,
    // otherwise probe by seeking and checking the frames aren't black.
    const streaming = opts?.streaming ?? !(await probeSeekable(video, fps));
    video.loop = streaming;          // streaming plays + loops; seekable stays paused
    try { video.currentTime = 0; } catch { /* ignore */ }
    return new VideoElementFrameSource(gpuHost, video, objectUrl, fps, blob.type, streaming);
  }

  async decode(idx: number, outTexHandle: number): Promise<void> {
    if (this.streaming) {
      // Live sampling — `idx` ignored. The element plays + loops itself
      // (play/pause is driven explicitly via setPlaying, not here, so a
      // paused frame-step doesn't accidentally resume continuous play);
      // we copy whatever frame is current (sparse-keyframe clips only
      // decode cleanly forward).
      if (this.video.readyState < 2) await this.waitForFrame();
    } else {
      // Random access — seek to the requested frame. Lands mid-cell so
      // rounding doesn't pull the previous frame at exact boundaries.
      const t = Math.min(
        Math.max(0, this.video.duration - 1e-3),
        idx / this.fps + 0.5 / this.fps,
      );
      await seekVideo(this.video, t, this.fps, SEEK_TIMEOUT_MS);
    }
    const tex = this.gpuHost.getTextureByHandle(outTexHandle);
    if (!tex) throw new Error(`output texture handle ${outTexHandle} not found`);
    this.device.queue.copyExternalImageToTexture(
      { source: this.video, flipY: false },
      { texture: tex },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );
  }

  /** Streaming sources: play/pause the element so the preview can freeze
   *  on pause without the element drifting ahead. No-op when seekable
   *  (those are driven frame-by-frame through decode()). */
  setPlaying(playing: boolean): void {
    if (!this.streaming) return;
    if (playing) {
      if (this.video.paused && !this.video.ended) {
        void this.video.play().catch(() => { /* autoplay blocked? */ });
      }
    } else if (!this.video.paused) {
      this.video.pause();
    }
  }

  /** Streaming sources: nudge the element forward ~one frame while paused.
   *  A small forward seek the decoder serves from its current position
   *  (cheap, unlike a cold mid-GOP seek), keeping the element paused. */
  async stepForward(): Promise<void> {
    if (!this.streaming) return;
    const t = Math.min(
      Math.max(0, this.video.duration - 1e-3),
      this.video.currentTime + 1 / this.fps,
    );
    await seekVideo(this.video, t, this.fps, SEEK_TIMEOUT_MS);
    // Seeking a paused element leaves it paused; guard against any UA that
    // resumes on currentTime assignment.
    if (!this.video.paused) this.video.pause();
  }

  private waitForFrame(): Promise<void> {
    return new Promise((resolve) => {
      if (this.video.readyState >= 2) { resolve(); return; }
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); resolve(); };
      const onData = () => done();
      const cleanup = () => this.video.removeEventListener('loadeddata', onData);
      const timer = setTimeout(done, SEEK_TIMEOUT_MS);
      this.video.addEventListener('loadeddata', onData, { once: true });
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

/** Seek `video` to `t` and resolve when the frame is ready (`seeked` /
 *  rVFC) or `timeoutMs` elapses. Never rejects, so a no-op seek that
 *  fires no event can't hang the caller. */
function seekVideo(
  video: HTMLVideoElement, t: number, fps: number, timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < (0.5 / fps) && video.readyState >= 2) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onSeeked = () => done();
    const rvfc = (video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => void;
    }).requestVideoFrameCallback;
    const timer = setTimeout(done, timeoutMs);
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
    };
    video.addEventListener('seeked', onSeeked);
    if (typeof rvfc === 'function') rvfc.call(video, () => done());
    video.currentTime = t;
  });
}

/** Probe whether a clip seeks cleanly: seek to several mid-clip
 *  positions and check the frames aren't black. A frequent-keyframe clip
 *  decodes every position (all non-black); a sparse-keyframe clip returns
 *  black wherever the seek lands deep in a long GOP (the browser won't
 *  decode hundreds of frames for one seek). We require a MAJORITY of
 *  probe points to be non-black — a single black point isn't enough to
 *  condemn a clip (could be a genuinely dark moment), but several are.
 *  Mid-clip fractions avoid start/end fade-to-black. Errs toward
 *  streaming (the always-safe mode) when it can't tell. */
async function probeSeekable(video: HTMLVideoElement, fps: number): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  try {
    ctx = new OffscreenCanvas(32, 18).getContext('2d', { willReadFrequently: true });
  } catch { return false; }
  if (!ctx) return false;
  const dur = video.duration;

  const lumAt = async (frac: number): Promise<number> => {
    await seekVideo(video, dur * frac, fps, PROBE_SEEK_TIMEOUT_MS);
    try {
      ctx!.drawImage(video, 0, 0, 32, 18);
      const d = ctx!.getImageData(0, 0, 32, 18).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += Math.max(d[i], d[i + 1], d[i + 2]);
      return sum / (d.length / 4);
    } catch {
      return -1;   // drawImage can throw if no frame is decoded → treat as black
    }
  };

  const fracs = [0.3, 0.45, 0.6, 0.78];
  let black = 0;
  for (const f of fracs) {
    if ((await lumAt(f)) <= PROBE_BLACK_THRESH) black++;
  }
  // Seekable only if at most one probe point came back black.
  return black <= 1;
}

/** Measure a video's real frame rate by sampling rVFC presentation
 *  timestamps. Plays muted for a handful of frames, takes the median
 *  inter-frame delta, then pauses. Falls back to 30 without rVFC. */
export function measureFps(video: HTMLVideoElement): Promise<number> {
  const rvfc = (video as unknown as {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => void;
  }).requestVideoFrameCallback;
  if (typeof rvfc !== 'function') return Promise.resolve(30);

  return new Promise<number>((resolve) => {
    const mediaTimes: number[] = [];
    let done = false;
    const finish = (fps: number) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      try { video.pause(); } catch { /* ignore */ }
      resolve(fps);
    };
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      mediaTimes.push(meta.mediaTime);
      if (mediaTimes.length < 8) { rvfc.call(video, onFrame); return; }
      const deltas: number[] = [];
      for (let i = 1; i < mediaTimes.length; i++) {
        const d = mediaTimes[i] - mediaTimes[i - 1];
        if (d > 1e-4) deltas.push(d);
      }
      if (deltas.length === 0) { finish(30); return; }
      deltas.sort((a, b) => a - b);
      const med = deltas[deltas.length >> 1];
      finish(med > 0 ? Math.max(1, Math.min(120, Math.round(1 / med))) : 30);
    };
    const safety = setTimeout(() => finish(30), 1500);
    rvfc.call(video, onFrame);
    video.play().catch(() => finish(30));
  });
}
