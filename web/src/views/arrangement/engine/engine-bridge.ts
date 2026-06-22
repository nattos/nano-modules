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
import { clipToRender, type ClipRender } from './clip-sketch';
import { store } from '../state/store';
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

  /** Per composite-layer content signature (sketchId → sig) for dedupe. */
  private shownSigs = new Map<string, string>();
  /** Layer sketchIds in composite DRAW order (bottom → top). */
  private layerOrder: string[] = [];
  /** Layer sketchId → clip id, so the capture tap attributes frames. */
  private layerClip = new Map<string, string>();
  /** Offscreen surface the per-frame layers composite into (one output bitmap). */
  private comp: OffscreenCanvas | null = null;

  /** Whether the playhead maps to any renderable composite layer. */
  hasContent = false;
  /** Last reported engine FPS (plain field; poll if you need it). */
  fps = 0;
  /** Last engine error message, if any. */
  error: string | null = null;
  /** Count of composited frames delivered (test/diagnostic hook). */
  framesSeen = 0;

  /** Number of active composite layers (diagnostic). */
  layerCount(): number { return this.layerOrder.length; }

  /** Boot the engine on first real use; idempotent. */
  private ensureEngine(): ArrEngine {
    if (this.engine) return this.engine;
    const e = new ArrEngine(RENDER_W, RENDER_H);
    e.onFrameSet = (frames) => this.onFrameSet(frames);
    e.onFps = (f) => { this.fps = f; };
    e.onError = (m) => { this.error = m; };
    // Wire-modulation telemetry → store, mirroring the IDE's
    // appState.local.engine.modulationData (sliders draw live mod bands from it).
    e.onModulationDataDiff = (diff) => store.applyModulationDataDiff(diff);
    this.engine = e;
    return e;
  }

  /** Composite a frame's layers (in draw order) into one bitmap, deliver, free. */
  private onFrameSet(frames: Record<string, ImageBitmap>) {
    this.framesSeen++;
    // Capture tap per layer first (Component D thumbnails attribute to the clip).
    if (this.tap) {
      for (const id of this.layerOrder) {
        const cid = this.layerClip.get(id);
        if (cid && frames[id]) this.tap(cid, frames[id]);
      }
    }
    if (this.sink) {
      const out = this.composite(frames);
      if (out) { this.sink(out); out.close(); }
    }
    for (const id in frames) frames[id].close();
  }

  /** Draw the active layers source-over (bottom → top) → one output bitmap. */
  private composite(frames: Record<string, ImageBitmap>): ImageBitmap | null {
    const ids = this.layerOrder.filter((id) => frames[id]);
    if (ids.length === 0) return null;
    if (!this.comp) this.comp = new OffscreenCanvas(RENDER_W, RENDER_H);
    const ctx = this.comp.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, RENDER_W, RENDER_H);
    for (const id of ids) ctx.drawImage(frames[id], 0, 0, RENDER_W, RENDER_H);
    return this.comp.transferToImageBitmap();
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

  /** Effect ids discovered across loaded bundles (diagnostic). */
  discoveredEffects(): string[] {
    return this.engine ? [...this.engine.discovered] : [];
  }

  /** create/update sketch call count (diagnostic). */
  showCount(): number {
    return this.engine?.showCount ?? 0;
  }

  setDebugMode(on: boolean) { this.engine?.setDebugMode(on); }
  debugStats(): unknown { return this.engine?.lastDebugStats ?? null; }

  get ready(): Promise<void> | null {
    return this.engine?.ready ?? null;
  }

  /**
   * Reflect the timeline at the playhead into the engine: a stack of active
   * clips (in composite draw order) each rendered as its own traced layer.
   * Idempotent and cheap to call every frame — it only issues engine commands
   * when the active set, layer order, or any layer's sketch changes, and drops
   * sketches for clips that left the playhead.
   */
  showComposite(layers: Array<{ clip: Clip }>) {
    const renders = layers
      .map((l) => ({ clip: l.clip, render: clipToRender(l.clip) }))
      .filter((x): x is { clip: Clip; render: ClipRender } => !!x.render);

    this.hasContent = renders.length > 0;
    const order: string[] = [];
    const active = new Set<string>();
    const engineLayers: Array<{ sketchId: string } & Pick<ClipRender, 'sketch' | 'opts'>> = [];
    let changed = false;

    for (const { clip, render } of renders) {
      const sketchId = `clip:${clip.id}`;
      order.push(sketchId);
      active.add(sketchId);
      this.layerClip.set(sketchId, clip.id);
      engineLayers.push({ sketchId, sketch: render.sketch, opts: render.opts });
      if (this.shownSigs.get(sketchId) !== render.sig) {
        this.shownSigs.set(sketchId, render.sig);
        changed = true;
      }
    }
    if (order.join('|') !== this.layerOrder.join('|')) changed = true;

    // Drop sketches for clips no longer active.
    for (const id of [...this.shownSigs.keys()]) {
      if (!active.has(id)) {
        this.engine?.deleteSketch(id);
        this.shownSigs.delete(id);
        this.layerClip.delete(id);
        changed = true;
      }
    }
    this.layerOrder = order;

    if (!changed) return;
    // Boot the engine only when there's something to show; otherwise just clear
    // traces on an already-booted engine so the monitor falls to placeholder.
    if (renders.length === 0) {
      if (this.engine) void this.engine.showComposite([]);
      return;
    }
    void this.ensureEngine().showComposite(engineLayers);
  }

  destroy() {
    this.engine?.destroy();
    this.engine = null;
    this.sink = null;
    this.tap = null;
    this.shownSigs.clear();
    this.layerOrder = [];
    this.layerClip.clear();
    this.comp = null;
  }
}

/** App-wide singleton (mirrors the `store` singleton). Engine boots lazily. */
export const engineBridge = new EngineBridge();
