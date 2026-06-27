/**
 * ThumbnailController — the app-wide owner of the real film-strip thumbnail
 * pipeline (Component D wired into the app).
 *
 * Composes the pieces that were built + tested in isolation:
 *   VideoThumbnailProducer (DXV decode → GPU readback → downscaled ImageBitmap)
 *     → ThumbnailManager (tiered memory → persistent store, mip, views, peek)
 *       → WorkerThumbStore (OPFS packs + WebP, off-thread) for cold-start reuse.
 *
 * Lazily boots a dedicated WebGPU device + playback service on first use (so
 * pages/tests that show no video clip pay nothing). Media is registered by a
 * stable `sourceKey` → URL; `openClip` fetches it as a File and opens it through
 * the playback service (DXV is random-access, so any frame decodes on demand).
 *
 * Surfaces draw via `peek()` (sync, best-available + stretch) and declare the
 * visible range with `setView()`; `subscribe()` notifies them as tiles land.
 */

import { GPUHost } from '../../../gpu-host';
import { VideoPlaybackService, ClipHandle } from '../../../video/playback-service';
import { VideoThumbnailProducer } from './video-thumbnail-producer';
import { ThumbnailManager, type ThumbView, type ThumbHit } from './thumbnail-manager';
import { identityCodec } from './thumbnail-store';
import { WorkerThumbStore } from './worker-thumb-store';
import { levelForFramesPerThumb } from './thumbnail-mip';

export interface ClipMedia {
  /** Stable identity for cache keys (a file change should change this). */
  sourceKey: string;
  /** Fetchable URL of the media (served asset or object URL). */
  url: string;
  /** Total source frames (clamps the thumbnail frame range). */
  frameCount: number;
  fps?: number;
}

/** The film strip's frame layout for a clip body of `width`×`height` px. */
export interface ReelLayout {
  /** Number of frame cells across the strip. */
  cells: number;
  /** Source frame represented by each cell (length === cells). */
  frames: number[];
  /** Mip level the cells request (granularity ≈ frames-per-cell). */
  level: number;
}

/**
 * Pure: how many thumbnail cells fit, which source frames they show, and at what
 * mip level. Mirrors `drawFilmReel`'s cell layout (16:9 cells across full height)
 * so the read keys line up with the draw. Exported for unit tests.
 */
export function reelLayout(width: number, height: number, frameCount: number, cellAspect = 16 / 9): ReelLayout {
  if (height <= 2 || width <= 0 || frameCount <= 0) return { cells: 0, frames: [], level: 0 };
  // Cell width = the SOURCE aspect (the reel draws panels at h·aspect), so the decoded
  // frame granularity (level) + cell count match the panels the strip actually tiles —
  // otherwise a non-16:9 source decodes too few frames and the strip can't track the output.
  const cellW = Math.max(8, height * cellAspect);
  const cells = Math.max(1, Math.round(width / cellW));
  const last = Math.max(0, frameCount - 1);
  const frames: number[] = [];
  for (let i = 0; i < cells; i++) {
    frames.push(Math.round(((i + 0.5) / cells) * last));
  }
  // Granularity: roughly one tile per cell across the whole clip.
  const framesPerCell = Math.max(1, frameCount / cells);
  return { cells, frames, level: levelForFramesPerThumb(framesPerCell) };
}

type Listener = (sourceKey: string, frame: number) => void;

export class ThumbnailController {
  private manager: ThumbnailManager<ImageBitmap> | null = null;
  private initPromise: Promise<ThumbnailManager<ImageBitmap>> | null = null;
  private media = new Map<string, ClipMedia>();
  // The booted main-thread GPU stack — SHARED so other arrangement consumers
  // (the video compositor pump) don't create a second device (which conflicts
  // with this one under headless WebGPU). Assigned in `ensure()`.
  private device: GPUDevice | null = null;
  private gpuHostShared: GPUHost | null = null;
  private serviceShared: VideoPlaybackService | null = null;
  private producer: VideoThumbnailProducer | null = null;
  private listeners = new Set<Listener>();
  /** Count of tiles that have landed in memory (test/diagnostic hook). */
  tilesFilled = 0;

  /** Register (or update) media under its sourceKey. Idempotent. */
  registerMedia(media: ClipMedia) {
    this.media.set(media.sourceKey, media);
  }

  hasMedia(sourceKey: string): boolean {
    return this.media.has(sourceKey);
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get isBooted(): boolean {
    return this.manager !== null;
  }

  /** Boot the GPU device + service + manager on first use. */
  private ensure(): Promise<ThumbnailManager<ImageBitmap>> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      // Retry adapter+device creation: when the engine worker and this main-thread
      // device initialize together, Dawn can transiently drop the GPU instance
      // ("a valid external Instance reference no longer exists") — a fresh request
      // a tick later succeeds.
      let device: GPUDevice | null = null;
      for (let attempt = 0; attempt < 4 && !device; attempt++) {
        try {
          const adapter = await navigator.gpu?.requestAdapter();
          if (!adapter) throw new Error('no WebGPU adapter for thumbnails');
          const required: GPUFeatureName[] = [];
          // DXV's BC1 fast path; harmless when absent.
          if (adapter.features.has('texture-compression-bc')) required.push('texture-compression-bc');
          device = await adapter.requestDevice({ requiredFeatures: required });
        } catch (err) {
          if (attempt === 3) throw err;
          await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
        }
      }
      const gpuHost = new GPUHost(device!, 'rgba8unorm');
      const service = new VideoPlaybackService(gpuHost, { dxvWasmUrl: '/wasm/dxv_decoder.wasm' });
      this.device = device;
      this.gpuHostShared = gpuHost;
      this.serviceShared = service;

      const openClip = async (sourceKey: string): Promise<ClipHandle> => {
        const m = this.media.get(sourceKey);
        if (!m) throw new Error(`thumbnails: no media for ${sourceKey}`);
        const res = await fetch(m.url);
        const buf = await res.arrayBuffer();
        const name = m.url.split('/').pop() || 'clip';
        // A still image is a 1-frame source (drop-import: 1 frame / 1 fps). Tag it with
        // an image MIME so the playback service routes it to ImageFrameSource instead of
        // the video decoders (the blob URL has no extension to sniff). createImageBitmap
        // decodes the real format regardless of this hint.
        const type = m.frameCount <= 1 ? 'image/png'
          : name.endsWith('.mp4') ? 'video/mp4'
          : name.endsWith('.webm') ? 'video/webm'
          : 'video/quicktime';
        const file = new File([buf], name, { type });
        return service.open(file, `arr:${sourceKey}`);
      };

      const producer = new VideoThumbnailProducer(service, gpuHost, openClip, 160, 90);
      this.producer = producer;
      const mgr = new ThumbnailManager<ImageBitmap>(
        producer,
        new WorkerThumbStore(),
        identityCodec<ImageBitmap>(),
        { dispose: (b) => b.close(), baseCapacity: 128 },
      );
      mgr.onChange = (sk, f) => {
        this.tilesFilled++;
        for (const l of this.listeners) l(sk, f);
      };
      this.manager = mgr;
      return mgr;
    })();
    return this.initPromise;
  }

  /**
   * Boot (if needed) and return the SHARED main-thread GPU stack so the video
   * compositor decode pump can reuse this device instead of creating a second
   * one (which fails under headless WebGPU: "external Instance reference no
   * longer exists"). Same device → same handle space.
   */
  async sharedGpu(): Promise<{ device: GPUDevice; gpuHost: GPUHost; service: VideoPlaybackService }> {
    await this.ensure();
    return { device: this.device!, gpuHost: this.gpuHostShared!, service: this.serviceShared! };
  }

  /** Decode a single frame at near-native resolution for the large clip-details
   *  preview (the strip's 160×90 tiles are too blurry there). `registerMedia` must
   *  have been called for `sourceKey`. Returns null if the media can't be opened. */
  async decodePreview(sourceKey: string, frame: number, maxDim = 720): Promise<ImageBitmap | null> {
    await this.ensure();
    if (!this.producer) return null;
    try { return await this.producer.producePreview(sourceKey, frame, maxDim); }
    catch { return null; }
  }

  /** Declare interest in a source's full frame range at `level` (prefetch). */
  setView(viewId: string, view: ThumbView) {
    void this.ensure().then((m) => m.setView(viewId, view)).catch(() => {});
  }

  /** Drop a view (clip left the viewport / unmounted). */
  dropView(viewId: string) {
    if (this.manager) this.manager.setView(viewId, null);
  }

  /**
   * Best-available tile for (sourceKey, frame, level), synchronous. Returns null
   * until the manager has booted and a tile (exact or substitute) is resident.
   */
  peek(sourceKey: string, frame: number, level: number, maxDistanceFrames = Infinity): ThumbHit<ImageBitmap> | null {
    return this.manager?.peek(sourceKey, frame, level, maxDistanceFrames) ?? null;
  }
}

/** App-wide singleton (mirrors `store` / `engineBridge`). Boots lazily. */
export const thumbnailController = new ThumbnailController();
