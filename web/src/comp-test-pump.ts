/**
 * comp-test-pump — the decode pump for the headless comp scenario runner.
 *
 * `comp::CompExecutor` never decodes: it publishes a desc set and blocks on
 * `setVideoReady`. In the app that contract is served by `EngineBridge`'s
 * `VideoCompositor`, but the scenario runner deliberately drives `ArrEngine`
 * directly (the bridge's worker owns the transport and free-runs, which makes
 * fixed-step comparison impossible). So the runner brings its own pump — the
 * TS twin of `native/src/media/video_pump.cpp`, and the same shape: desc + beat
 * → source frame → `VideoPlaybackService.pull` → placement blit → inject.
 *
 * The important difference from the compositor: every step is AWAITED. The
 * compositor is fire-and-forget because it must not stall a live rAF loop; here
 * a frame that isn't ready when the step returns is a determinism bug, not a
 * dropped frame.
 *
 * The cache, cost tracker, classifier and read-ahead all live inside
 * VideoPlaybackService — the same policy the native pump runs from its
 * lock-step twins (native/src/media/*.h ↔ src/video/*.ts), so hit rate and
 * precache depth mean the same thing on both sides.
 */

import type { VideoPlaybackService, ClipHandle } from './video/playback-service';
import { FrameBlitter, type BlitFit, type BlitTransform } from './video/frame-blitter';
import { GPUHost } from './gpu-host';
import { clipSourceFrameAt, clipNoiseSeed, type ClipTimeCtx }
  from './views/arrangement/engine/clip-time';
import type { ClipLoopConfig } from './views/arrangement/model/composition';

/** One entry of the comp executor's published desc set. */
interface VideoDesc {
  clipId: string;
  instanceKey: string;
  url?: string;
  startBeat: number;
  lengthBeat: number;
  durationFrames?: number;
  fps?: number;
  scaleMode?: string;
  transform?: Partial<BlitTransform>;
  loop?: ClipLoopConfig;
  holdBeat?: number;
  prime?: boolean;
  transport?: boolean;
}

/** Per-clip counters, mirroring native ClipTelemetry. */
export interface PumpClipTelemetry {
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  injects: number;
  cachedFrames: number;
  cacheBytes: number;
  costClass: string;
  accessMode: string;
  meanDecodeMs: number;
  seekDecodeMs: number;
}

const DEFAULT_LOOP: ClipLoopConfig = {
  mode: 'time', startSec: 0, speed: 1, direction: 'forward',
} as ClipLoopConfig;

const IDENTITY: BlitTransform = {
  anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false,
};

interface Clip {
  desc: VideoDesc;
  handle: ClipHandle;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  lastPresentedFrame: number;
  injects: number;
}

export class CompTestPump {
  private readonly service: VideoPlaybackService;
  private blitter: FrameBlitter;
  private clips = new Map<string, Clip>();
  private skippedIds = new Map<string, string>();

  constructor(
    private readonly gpuHost: GPUHost,
    device: GPUDevice,
    service: VideoPlaybackService,
    private readonly renderW: number,
    private readonly renderH: number,
    private readonly inject: (instanceKey: string, bitmap: ImageBitmap | null) => void,
    private readonly ready: (clipId: string, isReady: boolean) => void,
  ) {
    // The SHARED main-thread stack (thumbnailController.sharedGpu). A second
    // requestDevice fails outright under headless WebGPU, and the service's
    // texture handles only mean anything against its own host.
    this.service = service;
    this.blitter = new FrameBlitter(device);
  }

  /** Clip ids nothing here can decode, with the reason (native: `skipped()`). */
  get skipped(): Record<string, string> {
    return Object.fromEntries(this.skippedIds);
  }

  /** Reconcile against the comp executor's published desc set. */
  async setActiveClips(descsJson: string): Promise<void> {
    let descs: VideoDesc[] = [];
    try {
      descs = JSON.parse(descsJson) as VideoDesc[];
    } catch { return; }

    const live = new Set(descs.map((d) => d.clipId));
    for (const [id, c] of [...this.clips]) {
      if (live.has(id)) continue;
      // Unbind BEFORE closing: the executor must not hold a handle into a
      // cache that is about to release its textures.
      this.inject(c.desc.instanceKey, null);
      this.ready(id, false);
      await this.service.close(c.handle);
      this.clips.delete(id);
    }

    for (const d of descs) {
      // Transport-DRIVEN clips follow a published per-frame times channel
      // rather than their ClipLoopConfig; neither runner reads it.
      if (d.transport) {
        this.skippedIds.set(d.clipId, 'transport-driven clip (unsupported in the runner)');
        continue;
      }
      const existing = this.clips.get(d.clipId);
      if (existing) {
        existing.desc = d;   // startBeat/loop/placement can move under us
        continue;
      }
      if (this.skippedIds.has(d.clipId)) continue;
      if (!d.url) {
        this.skippedIds.set(d.clipId, 'no fetchable url');
        continue;
      }
      try {
        const blob = await (await fetch(d.url)).blob();
        const handle = await this.service.open(blob, d.clipId);
        const info = this.service.inspect(handle);
        this.clips.set(d.clipId, {
          desc: d,
          handle,
          width: info.width,
          height: info.height,
          frameCount: info.frameCount,
          // The container's rate wins when it has one; else the document's,
          // then 30 — the same fallback chain the native pump documents.
          fps: info.fps > 0 ? info.fps : (d.fps && d.fps > 0 ? d.fps : 30),
          lastPresentedFrame: -1,
          injects: 0,
        });
      } catch (err) {
        this.skippedIds.set(d.clipId, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Decode + present every active clip at `beat`. Resolves when every clip's
   *  frame has actually landed in the executor. */
  async pump(beat: number, bpm: number): Promise<number> {
    let presented = 0;
    for (const c of this.clips.values()) {
      const d = c.desc;
      let at = beat;
      // Linger clamp: freeze at the pass-end beat while a handover pends.
      if (d.holdBeat != null && at > d.holdBeat) at = d.holdBeat;
      // A clip not yet reached targets its ENTRY frame.
      if (at < d.startBeat - 1e-6 || d.prime) at = d.startBeat;

      const ctx: ClipTimeCtx = {
        startBeat: d.startBeat,
        lengthBeat: d.lengthBeat,
        videoDurSec: c.frameCount / Math.max(1, c.fps),
        secondsAt: (b: number) => b * (60 / Math.max(1, bpm)),
        seed: clipNoiseSeed(d.clipId),
      };
      const frame = clipSourceFrameAt(d.loop ?? DEFAULT_LOOP, ctx, at, c.fps, c.frameCount);
      if (frame == null) {
        // Off the slice → transparent, and NOT ready: nothing should hold the
        // transport waiting for a frame that will never come.
        if (c.lastPresentedFrame !== -1) {
          c.lastPresentedFrame = -1;
          this.inject(d.instanceKey, null);
        }
        continue;
      }

      const handle = await this.service.pull(c.handle, frame);
      if (handle <= 0) continue;
      presented++;
      if (frame === c.lastPresentedFrame) continue;   // held frame: already bound

      const tex = this.gpuHost.getTextureByHandle(handle);
      if (!tex) continue;
      const bitmap = this.blitter.toImageBitmap(
        tex, this.renderW, this.renderH,
        (d.scaleMode ?? 'fit') as BlitFit,
        { ...IDENTITY, ...(d.transform ?? {}) },
        this.renderW, this.renderH,
      );
      c.lastPresentedFrame = frame;
      c.injects++;
      this.inject(d.instanceKey, bitmap);
      this.ready(d.clipId, true);
    }
    return presented;
  }

  telemetry(): Record<string, PumpClipTelemetry> {
    const out: Record<string, PumpClipTelemetry> = {};
    for (const [id, c] of this.clips) {
      const s = this.service.inspect(c.handle);
      out[id] = {
        cacheHits: s.cache.hits,
        cacheMisses: s.cache.misses,
        hitRate: s.cache.hitRate,
        injects: c.injects,
        cachedFrames: s.cachedFrameIndices.length,
        cacheBytes: s.cache.bytes,
        costClass: s.cost.costClass,
        accessMode: s.access.mode,
        meanDecodeMs: s.cost.meanFrameDecodeMs,
        seekDecodeMs: s.cost.seekDecodeMs,
      };
    }
    return out;
  }

  async dispose(): Promise<void> {
    for (const [id, c] of [...this.clips]) {
      this.inject(c.desc.instanceKey, null);
      this.ready(id, false);
      await this.service.close(c.handle);
    }
    this.clips.clear();
  }
}
