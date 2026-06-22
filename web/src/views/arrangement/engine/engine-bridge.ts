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
 *  - RETAIN the latest traced frame per active clip (`engineFrame(clipId)`) and
 *    notify a listener (`setOnComposite`) each frame. The monitor is the unified
 *    compositor: it interleaves these engine frames with decoded media frames in
 *    z-order (so a media clip can sit between two effect layers) and applies
 *    per-track opacity — things a single in-bridge composite couldn't express.
 *  - An optional capture tap (Component D live thumbnails) still sees each layer.
 */

import { ArrEngine } from './arr-engine';
import { clipToRender, type ClipRender } from './clip-sketch';
import { store } from '../state/store';
import type { Clip } from '../model/composition';

/** Fired once per rendered frame after the latest engine frames are retained. */
export type CompositeListener = () => void;
/** Best-effort capture of the active clip's frames (Component D). */
export type FrameTap = (clipId: string, bitmap: ImageBitmap) => void;

const RENDER_W = 640;
const RENDER_H = 360;

export class EngineBridge {
  private engine: ArrEngine | null = null;
  private onCompositeCb: CompositeListener | null = null;
  private tap: FrameTap | null = null;

  /** Per composite-layer content signature (sketchId → sig) for dedupe. */
  private shownSigs = new Map<string, string>();
  /** Layer sketchIds in composite DRAW order (bottom → top). */
  private layerOrder: string[] = [];
  /** Layer sketchId → clip id, so the capture tap attributes frames. */
  private layerClip = new Map<string, string>();
  /** Latest retained engine frame per clip id (the monitor reads these). */
  private latest = new Map<string, ImageBitmap>();

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
    // Real plugin schemas → store, so the inspector renders complete editors
    // (color/bool/enum/vec) instead of the catalog's float-only synthesis.
    e.onPlugins = (plugins) => store.setEnginePlugins(plugins);
    this.engine = e;
    return e;
  }

  /** Retain this frame's layer bitmaps per clip, tap them, then notify. */
  private onFrameSet(frames: Record<string, ImageBitmap>) {
    this.framesSeen++;
    const retained = new Set<string>();
    for (const id of this.layerOrder) {
      const bmp = frames[id];
      if (!bmp) continue;
      const cid = this.layerClip.get(id);
      if (!cid) continue;
      if (this.tap) this.tap(cid, bmp); // Component D thumbnails, before retain
      this.latest.get(cid)?.close();    // drop the previous frame for this clip
      this.latest.set(cid, bmp);        // retain (closed on replace / departure)
      retained.add(id);
    }
    // Any traced bitmap we didn't retain (no clip mapping) must be freed.
    for (const id in frames) if (!retained.has(id)) frames[id].close();
    this.onCompositeCb?.();
  }

  /** The latest retained engine frame for a clip, or undefined. */
  engineFrame(clipId: string): ImageBitmap | undefined {
    return this.latest.get(clipId);
  }

  /** Listen for new engine frames (the monitor recomposites). Returns unsub. */
  setOnComposite(cb: CompositeListener | null): () => void {
    this.onCompositeCb = cb;
    return () => { if (this.onCompositeCb === cb) this.onCompositeCb = null; };
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

    // Drop sketches for clips no longer active (+ free their retained frame).
    for (const id of [...this.shownSigs.keys()]) {
      if (!active.has(id)) {
        this.engine?.deleteSketch(id);
        const cid = this.layerClip.get(id);
        if (cid) { this.latest.get(cid)?.close(); this.latest.delete(cid); }
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
    this.onCompositeCb = null;
    this.tap = null;
    this.shownSigs.clear();
    this.layerOrder = [];
    this.layerClip.clear();
    for (const bmp of this.latest.values()) bmp.close();
    this.latest.clear();
  }
}

/** App-wide singleton (mirrors the `store` singleton). Engine boots lazily. */
export const engineBridge = new EngineBridge();
