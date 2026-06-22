/**
 * EngineBridge — the app-wide seam between the arrangement store and ONE live
 * `ArrEngine` (Component C wired into the real app, not just the testbed).
 *
 * Responsibilities:
 *  - Own a single `ArrEngine`, booted **lazily** on first renderable selection
 *    (so pages/tests that never render don't spawn a worker + WebGPU device).
 *  - Translate "the selection changed" into engine calls: map the active clip to
 *    a real sketch (`clipToRender`), show it, and re-target the monitor trace —
 *    deduped so steady-state transport ticks don't re-issue commands.
 *  - Fan the engine's traced frames to a single frame sink (the monitor) plus an
 *    optional capture tap (Component D live thumbnails). The sink/tap own drawing
 *    from the bitmap; the bridge closes it once after delivery.
 *
 * Single consumer by design: `setFrameSink` replaces (not appends). Rendering the
 * same engine frame into multiple live surfaces (e.g. the bottom clip view) is a
 * later concern that needs per-consumer bitmap clones.
 */

import { ArrEngine } from './arr-engine';
import { clipToRender } from './clip-sketch';
import type { Clip } from '../model/composition';

/** Receives each traced frame. The bridge closes the bitmap after this returns. */
export type FrameSink = (bitmap: ImageBitmap) => void;
/** Best-effort capture of the active clip's frames (Component D). */
export type FrameTap = (clipId: string, bitmap: ImageBitmap) => void;

const RENDER_W = 640;
const RENDER_H = 360;

export class EngineBridge {
  private engine: ArrEngine | null = null;
  private sink: FrameSink | null = null;
  private tap: FrameTap | null = null;

  /** Content key currently shown by the engine (`ClipRender.id`), or null. */
  private shownKey: string | null = null;
  /** Clip whose frames the capture tap should be attributed to. */
  private activeClipId: string | null = null;

  /** Whether the active selection maps to renderable content. */
  hasContent = false;
  /** Last reported engine FPS (plain field; poll if you need it). */
  fps = 0;
  /** Last engine error message, if any. */
  error: string | null = null;
  /** Count of traced frames delivered (test/diagnostic hook). */
  framesSeen = 0;

  /** Boot the engine on first real use; idempotent. */
  private ensureEngine(): ArrEngine {
    if (this.engine) return this.engine;
    const e = new ArrEngine(RENDER_W, RENDER_H);
    e.onFrame = (_id, bmp) => this.dispatchFrame(bmp);
    e.onFps = (f) => { this.fps = f; };
    e.onError = (m) => { this.error = m; };
    this.engine = e;
    return e;
  }

  private dispatchFrame(bmp: ImageBitmap) {
    this.framesSeen++;
    // Capture tap first (it reads pixels; may downsample), then the live sink.
    if (this.tap && this.activeClipId) {
      // The tap must not retain the bitmap past this call.
      this.tap(this.activeClipId, bmp);
    }
    if (this.sink) this.sink(bmp);
    bmp.close();
  }

  /** Register the live frame sink (the monitor). Returns an unsubscribe fn. */
  setFrameSink(sink: FrameSink | null): () => void {
    this.sink = sink;
    return () => { if (this.sink === sink) this.sink = null; };
  }

  /** Register the capture tap (live thumbnails). Returns an unsubscribe fn. */
  setFrameTap(tap: FrameTap | null): () => void {
    this.tap = tap;
    return () => { if (this.tap === tap) this.tap = null; };
  }

  get isBooted(): boolean {
    return this.engine !== null;
  }

  get ready(): Promise<void> | null {
    return this.engine?.ready ?? null;
  }

  /**
   * Reflect the current selection into the engine. Idempotent and cheap to call
   * every frame: it only issues engine commands when the content key changes.
   */
  showClip(clip: Clip | null) {
    const render = clip ? clipToRender(clip) : null;
    this.hasContent = !!render;
    this.activeClipId = render ? clip!.id : null;
    if (!render) {
      this.shownKey = null;
      return;
    }
    const engine = this.ensureEngine();
    if (this.shownKey !== render.id) {
      this.shownKey = render.id;
      void engine.showSketch(render.id, render.slice.sketch, render.slice.opts);
    }
  }

  destroy() {
    this.engine?.destroy();
    this.engine = null;
    this.sink = null;
    this.tap = null;
    this.shownKey = null;
  }
}

/** App-wide singleton (mirrors the `store` singleton). Engine boots lazily. */
export const engineBridge = new EngineBridge();
