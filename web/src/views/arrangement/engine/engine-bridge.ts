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
import { buildCompositeSketch, clipInstanceKey } from './clip-sketch';
import { VideoCompositor, type VideoClipDesc } from './video-compositor';
import { VIDEO_SOURCE_TYPE } from './effect-catalog';
import { store } from '../state/store';
import type { Clip } from '../model/composition';
import type { TracePoint } from '../../../engine-types';
import type { TraceRegistration, TraceSource } from '../../../state/trace-controller';

/** Fired once per rendered frame after the latest engine frame is retained. */
export type CompositeListener = () => void;
/** Best-effort capture of the composite frame (Component D). */
export type FrameTap = (clipId: string, bitmap: ImageBitmap) => void;

/** Longest-edge cap for the live preview render (keeps multi-layer compositing
 *  responsive; the composition's true resolution is the export target, not this
 *  preview). The render keeps the composition's ASPECT ratio. */
const PREVIEW_MAX_EDGE = 1280;
/** Single sketch id the whole engine-layer stack composites into. */
const COMPOSITE_ID = 'arr-composite';

export class EngineBridge {
  private engine: ArrEngine | null = null;
  /** Current engine render size (composition aspect, capped). */
  private renderW = 640;
  private renderH = 360;
  private onCompositeCb: CompositeListener | null = null;
  private tap: FrameTap | null = null;

  /** Signature of the combined composite sketch (for dedupe). */
  private compositeSig = '';
  /** Latest retained composite frame (the monitor draws this). */
  private compositeFrame: ImageBitmap | null = null;
  /** Number of active ENGINE layers folded into the composite (diagnostic). */
  private engineLayerN = 0;

  /** Composite chain instance keys (in order) — maps a device's composite key to
   *  its chain index, for remapping per-device texture trace targets. */
  private compositeKeys: string[] = [];
  /** Per-device texture trace registrations (from output texture monitors). */
  private deviceRegs = new Map<string, TraceRegistration>();

  /**
   * The TraceSource injected into the arrangement's `<column-group>` so its
   * output texture monitors capture per-device `tex_out` from THIS engine. Each
   * monitor registers a clip-local chain_entry target; we remap it to the
   * composite chain and feed the device traces alongside the composite trace.
   */
  readonly traceSource: TraceSource = {
    register: (reg) => { this.deviceRegs.set(reg.id, reg); this.refreshDeviceTraces(); },
    unregister: (id) => { if (this.deviceRegs.delete(id)) this.refreshDeviceTraces(); },
    frame: (id) => store.tracedFrames[id],
    get generation() { return store.traceGeneration; },
  };

  /** Remap a monitor's clip-local chain_entry target to the live composite. */
  private remapDeviceTrace(reg: TraceRegistration): TracePoint | null {
    const t = reg.target;
    if (t.type !== 'chain_entry') return null;
    if (!t.sketchId.startsWith('clip/')) return null; // tracks don't render via the engine
    const [, trackId, clipId] = t.sketchId.split('/');
    const dev = store.trackById(trackId)?.clips.find((c) => c.id === clipId)?.sketch.devices[t.chainIdx];
    if (!dev) return null;
    const idx = this.compositeKeys.indexOf(clipInstanceKey(clipId, dev.id));
    if (idx < 0) return null; // clip not active at the playhead → no live frame
    const tp: TracePoint = { id: reg.id, target: { type: 'chain_entry', sketchId: COMPOSITE_ID, colIdx: 0, chainIdx: idx, side: t.side } };
    if (reg.size) tp.size = reg.size;
    return tp;
  }

  /** Push the (remapped) per-device texture traces to the engine. */
  private refreshDeviceTraces() {
    if (!this.engine) return;
    const tps: TracePoint[] = [];
    for (const reg of this.deviceRegs.values()) {
      const tp = this.remapDeviceTrace(reg);
      if (tp) tps.push(tp);
    }
    this.engine.setExtraTracePoints(tps);
  }

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

  /** Main-thread video decode pump (lazily created on first video clip). */
  private video: VideoCompositor | null = null;
  private videoCompositor(): VideoCompositor {
    if (!this.video) {
      const r = store.composition.meta.resolution;
      this.video = new VideoCompositor(
        (key, bmp) => this.setInstanceTexture(key, bmp),
        this.renderW,
        this.renderH,
        () => ({ beat: store.positionBeat, bpm: store.composition.meta.baseBPM }),
        Math.max(1, r.width),
        Math.max(1, r.height),
      );
    }
    return this.video;
  }

  /** Count of active video decode pumps (diagnostic / tests). */
  videoPumpCount(): number { return this.video?.pumpCount ?? 0; }
  /** Decoded frames pushed to the executor so far (diagnostic). */
  videoFramesInjected(): number { return this.video?.framesInjected ?? 0; }
  /** Last video decode/inject error, if any (diagnostic). */
  videoLastError(): string | null { return this.video?.lastError ?? null; }
  /** Last pulled frame per clip {frame,handle,w,h} (diagnostic). */
  videoLastPulled(): unknown { return this.video?.lastPulled ?? null; }

  /** Engine render size = composition resolution's aspect, capped to the preview
   *  max edge (even dimensions for clean GPU textures). */
  private renderSize(): { w: number; h: number } {
    const r = store.composition.meta.resolution;
    const rw = Math.max(1, r.width);
    const rh = Math.max(1, r.height);
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(rw, rh));
    const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
    return { w: even(rw), h: even(rh) };
  }

  /** Re-sync the engine + video pump render size to the composition resolution.
   *  Cheap to call every frame; only acts when the size actually changed. */
  syncResolution() {
    const { w, h } = this.renderSize();
    if (w === this.renderW && h === this.renderH) return;
    this.renderW = w;
    this.renderH = h;
    this.engine?.resize(w, h);
    const r = store.composition.meta.resolution;
    this.video?.setRenderSize(w, h, Math.max(1, r.width), Math.max(1, r.height));
    // Force a re-issue so the trace re-renders at the new size next frame.
    this.compositeSig = '';
  }

  /** Boot the engine on first real use; idempotent. */
  private ensureEngine(): ArrEngine {
    if (this.engine) return this.engine;
    const e = new ArrEngine(this.renderW, this.renderH);
    e.onFrameSet = (frames) => this.onFrameSet(frames);
    e.onFps = (f) => { this.fps = f; };
    e.onError = (m) => { this.error = m; };
    // Wire-modulation telemetry → store, mirroring the IDE's
    // appState.local.engine.modulationData (sliders draw live mod bands from it).
    e.onModulationDataDiff = (diff) => store.applyModulationDataDiff(diff);
    // Published instance state (outputs/broadcasts) → store, so output trace
    // spark-charts animate with live values (e.g. an LFO's `output`).
    e.onPluginStatesDiff = (diff) => store.applyPluginStatesDiff(diff);
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
    // Per-device traced textures (output trace cards) → the store (which closes
    // the previous frame's bitmaps and bumps the trace generation).
    const deviceFrames: Record<string, ImageBitmap> = {};
    for (const id in frames) if (id !== COMPOSITE_ID) deviceFrames[id] = frames[id];
    store.setTracedFrames(deviceFrames);
    this.onCompositeCb?.();
  }

  /** The latest combined composite frame (all engine layers), or undefined. */
  engineComposite(): ImageBitmap | undefined {
    return this.compositeFrame ?? undefined;
  }

  /** Bind a decoded video frame to a `source.video.file` instance (the video
   *  pump → the composite chain). No-op until the engine has booted. */
  setInstanceTexture(instanceKey: string, bitmap: ImageBitmap | null) {
    if (this.engine) this.engine.setInstanceTexture(instanceKey, bitmap);
    else bitmap?.close();
  }

  private lastTimeSent: number | null = null;
  /** Drive the engine's effect clock from the transport time (seconds). Deduped
   *  so a paused transport doesn't spam the worker. No-op until booted. */
  setTime(seconds: number) {
    if (!this.engine || this.lastTimeSent === seconds) return;
    this.lastTimeSent = seconds;
    this.engine.setTime(seconds);
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
  showComposite(layers: Array<{ clip: Clip; opacity?: number; blendMode?: number }>) {
    // Keep the engine + video render size matched to the composition resolution
    // (aspect-correct) before building/issuing this frame.
    this.syncResolution();
    // Every layer renders through the GPU composite now — video clips included
    // (their source.video.file entry outputs the host-injected decoded frame).
    const engineLayers = layers;
    this.engineLayerN = engineLayers.length;
    this.hasContent = engineLayers.length > 0;

    // Reconcile the main-thread video decode pumps with the active video clips
    // (each feeds its `source.video.file` entry). Cheap + diffed; the pump's own
    // rAF maps the live transport clock → frame, so this only handles the set.
    const videoDescs: VideoClipDesc[] = [];
    for (const l of engineLayers) {
      const src = l.clip.source;
      if (!src?.url) continue;
      const dev = l.clip.sketch.devices.find((d) => d.moduleType === VIDEO_SOURCE_TYPE);
      if (!dev) continue;
      videoDescs.push({
        clipId: l.clip.id,
        instanceKey: clipInstanceKey(l.clip.id, dev.id),
        url: src.url,
        sourceKey: src.sourceKey ?? l.clip.id,
        startBeat: l.clip.startBeat,
        lengthBeat: l.clip.lengthBeat,
        durationFrames: src.durationFrames,
        fps: src.fps,
        speed: l.clip.loop?.speed,
        scaleMode: src.scaleMode ?? 'fit',
      });
    }
    if (videoDescs.length > 0 || this.video) this.videoCompositor().setActiveClips(videoDescs);

    const render = engineLayers.length
      ? buildCompositeSketch(
          engineLayers.map((l) => ({ clip: l.clip, opacity: l.opacity ?? 1, blendMode: l.blendMode })),
        )
      : null;

    if (!render) {
      if (this.compositeSig !== '') {
        this.compositeSig = '';
        this.compositeKeys = [];
        this.refreshDeviceTraces();
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
    // Capture the composite chain order so per-device texture traces can map a
    // device's composite key → its chain index.
    this.compositeKeys = (render.sketch.chain ?? []).map((e) => (e as { instance_key?: string }).instance_key ?? '');
    void this.ensureEngine().showComposite([
      { sketchId: COMPOSITE_ID, sketch: render.sketch, opts: render.opts },
    ]);
    this.refreshDeviceTraces();
  }

  destroy() {
    this.video?.destroy();
    this.video = null;
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
