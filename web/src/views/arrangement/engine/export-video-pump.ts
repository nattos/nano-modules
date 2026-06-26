/**
 * ExportVideoPump — the DETERMINISTIC twin of `VideoCompositor`'s decode path,
 * for offline export. Where the live pump is rAF-driven and skips a clip that's
 * still decoding (realtime can't wait), the exporter AWAITS each clip's exact
 * source frame for a given beat, blits it to the FULL composition resolution, and
 * hands back the ImageBitmap — so every output frame is fully resolved before the
 * engine composites it (no Precise-gate dance, no dropped frames).
 *
 * Reuses the proven decode stack: the shared main-thread `VideoPlaybackService`
 * (one WebGPU device per page) + a `FrameBlitter`, and the SAME pure beat→source-
 * frame mapper (`clipSourceFrameAt`) the live pump and the film strips use.
 */

import { GPUHost } from '../../../gpu-host';
import { VideoPlaybackService, ClipHandle } from '../../../video/playback-service';
import { FrameBlitter, type BlitTransform } from '../../../video/frame-blitter';
import { thumbnailController } from '../media/thumbnail-controller';
import { clipSourceFrameAt, clipNoiseSeed, type ClipTimeCtx } from './clip-time';
import type { VideoClipDesc } from './video-compositor';
import type { ClipLoopConfig } from '../model/composition';

const IDENTITY_TRANSFORM: BlitTransform = {
  anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false,
};
/** Fallback timing for a clip missing its loop config: loop the whole source. */
const DEFAULT_LOOP: ClipLoopConfig = { mode: 'time', startSec: 0, speed: 1, direction: 'forward' };

interface Open {
  clip: ClipHandle;
  frameCount: number;
  fps: number;
  sourceKey: string;
  url: string;
}

export class ExportVideoPump {
  private device!: GPUDevice;
  private gpuHost!: GPUHost;
  private service!: VideoPlaybackService;
  private blitter!: FrameBlitter;
  /** Opened decoders, keyed by clipId. */
  private opens = new Map<string, Open>();

  constructor(
    /** Blit target = the export render size (the full composition resolution). */
    private readonly renderW: number,
    private readonly renderH: number,
    /** Composition resolution the 'none' scale mode reasons about (== render here). */
    private readonly compW = renderW,
    private readonly compH = renderH,
  ) {}

  /** Acquire the shared decode device + service (one per page). */
  async init(): Promise<void> {
    const { device, gpuHost, service } = await thumbnailController.sharedGpu();
    this.device = device;
    this.gpuHost = gpuHost;
    this.service = service;
    this.blitter = new FrameBlitter(device);
  }

  private async ensureOpen(d: VideoClipDesc): Promise<Open | null> {
    let o = this.opens.get(d.clipId);
    if (o && (o.sourceKey !== d.sourceKey || o.url !== d.url)) {
      await this.service.close(o.clip).catch(() => {});
      this.opens.delete(d.clipId);
      o = undefined;
    }
    if (!o) {
      const blob = await (await fetch(d.url)).blob();
      const clip = await this.service.open(blob, d.sourceKey, { sequential: false });
      const info = this.service.inspect(clip);
      o = {
        clip,
        frameCount: info.frameCount > 0 ? info.frameCount : Math.max(1, d.durationFrames),
        fps: info.fps > 0 ? info.fps : d.fps ?? 30,
        sourceKey: d.sourceKey,
        url: d.url,
      };
      this.opens.set(d.clipId, o);
    }
    return o;
  }

  /**
   * Decode the exact source frame for `desc` at `beat` and blit it to the export
   * render size, returning the ImageBitmap — or null when the clip is off its slice
   * (a one-shot before/after the source) and should composite transparent. The
   * caller owns/transfers the returned bitmap. `secondsAt` is the warp-aware
   * beat→seconds resolver (so video seeking matches the grid + the live pump).
   */
  async frameBitmapAt(
    desc: VideoClipDesc,
    beat: number,
    secondsAt: (beat: number) => number,
  ): Promise<ImageBitmap | null> {
    const o = await this.ensureOpen(desc);
    if (!o) return null;
    const ctx: ClipTimeCtx = {
      startBeat: desc.startBeat,
      lengthBeat: desc.lengthBeat,
      videoDurSec: o.frameCount / Math.max(1, o.fps),
      secondsAt,
      seed: clipNoiseSeed(desc.clipId),
    };
    // Pure mapper (incl. the deterministic 'random' approximation the strips use),
    // so an export is reproducible — no live stochastic walk.
    const frame = clipSourceFrameAt(desc.loop ?? DEFAULT_LOOP, ctx, beat, o.fps, o.frameCount);
    if (frame === null) return null;
    const handle = await this.service.pull(o.clip, frame);
    if (handle <= 0) return null;
    const tex = this.gpuHost.getTextureByHandle(handle);
    if (!tex) return null;
    return this.blitter.toImageBitmap(
      tex, this.renderW, this.renderH,
      desc.scaleMode ?? 'fit',
      desc.transform ?? IDENTITY_TRANSFORM,
      this.compW, this.compH,
    );
  }

  async close(): Promise<void> {
    for (const o of this.opens.values()) await this.service?.close(o.clip).catch(() => {});
    this.opens.clear();
  }
}
