/**
 * EngineBridge — the app-wide seam between the arrangement store and ONE live
 * `ArrEngine` (Component C wired into the real app, not just the testbed).
 *
 * Responsibilities:
 *  - Own a single `ArrEngine`, booted **lazily** on first renderable selection
 *    (so pages/tests that never render don't spawn a worker + WebGPU device).
 *  - Translate "the timeline at the playhead" into engine calls: fold all active
 *    ENGINE layers into ONE combined chain (`buildCompositeSketch`) so effect
 *    clips process the composite of the tracks above them, and show it — deduped
 *    so steady-state transport ticks don't re-issue commands.
 *  - RETAIN the latest combined composite frame (`engineComposite()`) and notify
 *    a listener (`setOnComposite`) each frame. The monitor draws that composite
 *    and layers decoded media frames around it (media isn't in the GPU chain).
 *  - An optional capture tap (Component D live thumbnails) sees the composite.
 */

import { ArrEngine } from './arr-engine';
import { buildCompositeSketch } from './clip-sketch';
import { store } from '../state/store';
import type { Clip } from '../model/composition';

/** Fired once per rendered frame after the latest engine frame is retained. */
export type CompositeListener = () => void;
/** Best-effort capture of the composite frame (Component D). */
export type FrameTap = (clipId: string, bitmap: ImageBitmap) => void;

const RENDER_W = 640;
const RENDER_H = 360;
/** Single sketch id the whole engine-layer stack composites into. */
const COMPOSITE_ID = 'arr-composite';

export class EngineBridge {
  private engine: ArrEngine | null = null;
  private onCompositeCb: CompositeListener | null = null;
  private tap: FrameTap | null = null;

  /** Signature of the combined composite sketch (for dedupe). */
  private compositeSig = '';
  /** Latest retained composite frame (the monitor draws this). */
  private compositeFrame: ImageBitmap | null = null;
  /** Number of active ENGINE layers folded into the composite (diagnostic). */
  private engineLayerN = 0;

  /** Whether the playhead maps to any renderable engine layer. */
  hasContent = false;
  /** Last reported engine FPS (plain field; poll if you need it). */
  fps = 0;
  /** Last engine error message, if any. */
  error: string | null = null;
  /** Count of composited frames delivered (test/diagnostic hook). */
  framesSeen = 0;

  /** Number of active engine layers in the composite (diagnostic). */
  layerCount(): number { return this.engineLayerN; }

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

  /** Retain the combined composite frame, tap it, then notify. */
  private onFrameSet(frames: Record<string, ImageBitmap>) {
    this.framesSeen++;
    const bmp = frames[COMPOSITE_ID];
    if (bmp) {
      if (this.tap) this.tap(COMPOSITE_ID, bmp); // Component D capture, before retain
      this.compositeFrame?.close();              // drop the previous composite
      this.compositeFrame = bmp;                 // retain (closed on replace)
    }
    // Any other traced bitmap (shouldn't happen) must be freed.
    for (const id in frames) if (id !== COMPOSITE_ID) frames[id].close();
    this.onCompositeCb?.();
  }

  /** The latest combined composite frame (all engine layers), or undefined. */
  engineComposite(): ImageBitmap | undefined {
    return this.compositeFrame ?? undefined;
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
   * Reflect the timeline at the playhead into the engine. The ENGINE layers
   * (clips without decoded media) are folded into ONE combined chain — top track
   * first — so an effect clip processes the composite of the tracks above it and
   * per-track opacity / alpha composite correctly (see `buildCompositeSketch`).
   * Media clips (decoded video) are excluded here; the monitor draws those.
   * Idempotent + cheap to call every frame: it re-issues only when the combined
   * composite actually changes, and clears the trace when nothing renders.
   */
  showComposite(layers: Array<{ clip: Clip; opacity?: number }>) {
    const engineLayers = layers.filter((l) => !l.clip.source?.url);
    this.engineLayerN = engineLayers.length;
    this.hasContent = engineLayers.length > 0;

    const render = engineLayers.length
      ? buildCompositeSketch(engineLayers.map((l) => ({ clip: l.clip, opacity: l.opacity ?? 1 })))
      : null;

    if (!render) {
      if (this.compositeSig !== '') {
        this.compositeSig = '';
        this.engine?.deleteSketch(COMPOSITE_ID);
        void this.engine?.showComposite([]); // clear the trace → placeholder
        this.compositeFrame?.close();
        this.compositeFrame = null;
        this.onCompositeCb?.();
      }
      return;
    }
    if (render.sig === this.compositeSig) return;
    this.compositeSig = render.sig;
    void this.ensureEngine().showComposite([
      { sketchId: COMPOSITE_ID, sketch: render.sketch, opts: render.opts },
    ]);
  }

  destroy() {
    this.engine?.destroy();
    this.engine = null;
    this.onCompositeCb = null;
    this.tap = null;
    this.compositeSig = '';
    this.engineLayerN = 0;
    this.compositeFrame?.close();
    this.compositeFrame = null;
  }
}

/** App-wide singleton (mirrors the `store` singleton). Engine boots lazily. */
export const engineBridge = new EngineBridge();
