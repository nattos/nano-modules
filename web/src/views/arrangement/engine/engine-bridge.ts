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
import { debugPerf } from '../state/debug-perf';
import { clipInstanceKey } from './clip-sketch';
import { VideoCompositor, type VideoClipDesc } from './video-compositor';
import { makeWarpClock } from './warp-clock';
import { videoInputsReady as gateVideoReady, shouldHoldPrecise, pumpActiveSet } from './precise-gate';
import { automationEntriesAtBeat, buildCompositeRenderAtBeat, videoDescFor } from './composite-frame';
import { store } from '../state/store';
import { deviceIsSource, type Clip, type Track } from '../model/composition';
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
/** How far ahead (in beats) to pre-open + pre-decode upcoming video clips. */
const LOOKAHEAD_BEATS = 8;

export class EngineBridge {
  private engine: ArrEngine | null = null;
  /** Current engine render size (composition aspect, capped). */
  private renderW = 640;
  private renderH = 360;
  private onCompositeCb: CompositeListener | null = null;
  private tap: FrameTap | null = null;

  /** Signature of the combined composite sketch (for dedupe). */
  private compositeSig = '';

  /** Video clips of the TARGET composite (current beat) — the Precise gate waits on
   *  these to be decoded + injected before issuing. */
  private lastVideoDescs: VideoClipDesc[] = [];
  /** Video clips of the composite CURRENTLY ON SCREEN. Kept alive in the decode pump
   *  while a Precise hold is pending so the held frame's textures aren't torn down
   *  (else the held composite goes transparent → the layers beneath flash through). */
  private displayedVideoDescs: VideoClipDesc[] = [];
  /** "Precise" mode: layers held back from the engine until their video inputs
   *  decode (so we never flash a not-yet-ready clip). Null = nothing held. */
  private pendingPrecise: Array<{ clip: Clip; opacity?: number; blendMode?: number; track?: Track }> | null = null;
  private preciseTimer: ReturnType<typeof setTimeout> | null = null;
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
    // The "Input" card (chain[0], side 'input') previews what feeds the chain.
    // For a source-led clip (video/generator at chain[0]) nothing flows INTO the
    // generator — its 'input' side is the upstream composite (transparent for a
    // topmost layer). The chain's actual content is the source's OUTPUT (the
    // injected video frame), so trace that instead.
    const side = t.side === 'input' && deviceIsSource(dev) ? 'output' : t.side;
    const tp: TracePoint = { id: reg.id, target: { type: 'chain_entry', sketchId: COMPOSITE_ID, colIdx: 0, chainIdx: idx, side } };
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
  /** Signature of the warp resolver currently installed on the pump; rebuilt only
   *  when the base tempo or any clip warp changes. */
  private warpSig = '';

  /** Keep the pump's warp-aware beat→seconds resolver in sync with the composition,
   *  so video timing seeks through warped regions the same way the grid draws them. */
  private refreshWarpResolver() {
    const comp = store.composition;
    const warps = comp.tracks.flatMap((t) => (t.clips ?? []).flatMap((c) => c.warps ?? []));
    const sig = `${comp.meta.baseBPM}|${JSON.stringify(warps)}`;
    if (sig === this.warpSig) return;
    this.warpSig = sig;
    const clock = makeWarpClock(comp);
    this.videoCompositor().setTimeResolver((beat) => clock.secondsAt(beat));
  }

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
      // Backfill authoritative source dimensions as clips decode (fixes the
      // placement widget's aspect for clips with no stored width/height).
      this.video.onClipInfo = (clipId, w, h) => store.noteClipSourceDims(clipId, w, h);
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
    e.onGpuTime = (g) => { if (debugPerf.active) debugPerf.lastGpuMs = g; };
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
      if (this.hasContent) {
        if (this.tap) this.tap(COMPOSITE_ID, bmp); // Component D capture, before retain
        this.compositeFrame?.close();              // drop the previous composite
        this.compositeFrame = bmp;                 // retain (closed on replace)
      } else {
        // Background-only (nothing committed): ignore a stale composite frame still in
        // flight from a just-deleted composite — else it lingers as the retained frame
        // and the next clip's commit draws it for a frame (the video→video flash).
        bmp.close();
      }
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
    // A video frame just landed — a held "Precise" composite may now have all
    // its inputs. Re-evaluate (showComposite re-holds if others are still out).
    if (this.pendingPrecise && this.videoInputsReady()) {
      const layers = this.pendingPrecise;
      this.pendingPrecise = null;
      this.showComposite(layers);
    }
  }

  /** True when every active video clip has its current-beat frame injected (see
   *  precise-gate.videoInputsReady for the invariants). */
  private videoInputsReady(): boolean {
    const beat = store.positionBeat;
    const bpm = store.composition.meta.baseBPM;
    return gateVideoReady(this.lastVideoDescs, !!this.video, (id) => this.video!.clipReady(id, beat, bpm));
  }

  /** Whether the transport may step this frame (Precise mode stalls on unready
   *  video inputs so time never runs ahead of the picture). */
  inputsReady(): boolean {
    return store.transportMode !== 'precise' || this.videoInputsReady();
  }

  private clearPreciseHold() {
    this.pendingPrecise = null;
    if (this.preciseTimer) { clearTimeout(this.preciseTimer); this.preciseTimer = null; }
  }

  private lastTimeSent: number | null = null;
  /** Drive the engine's effect clock from the transport time (seconds). Deduped
   *  so a paused transport doesn't spam the worker. No-op until booted. */
  setTime(seconds: number) {
    if (!this.engine || this.lastTimeSent === seconds) return;
    this.lastTimeSent = seconds;
    this.engine.setTime(seconds);
  }

  /**
   * Per frame: evaluate every active CLIP's automation lanes at the playhead and
   * push the values to the executor, which folds each into its target field via
   * tap_mod (no sketch re-issue). Deduped so a paused, unedited playhead is quiet.
   *
   * Both CLIP lanes (clip devices, clip-relative beats) and TRACK lanes (the
   * track's FX bus, absolute beats) drive — each active layer contributes its
   * clip's lanes (keyed `clip_*`) AND its track's lanes (keyed `track_*`). A
   * track's lanes are evaluated only here, where the track has an active clip and
   * its FX chain is in the composite.
   */
  pushAutomation() {
    if (!this.engine) return;
    const entries = automationEntriesAtBeat(store.positionBeat);
    const sig = JSON.stringify(entries);
    if (sig === this.lastAutoSig) return;
    this.lastAutoSig = sig;
    this.engine.setAutomation(entries);
  }
  private lastAutoSig = '';

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
  showComposite(layers: Array<{ clip: Clip; opacity?: number; blendMode?: number; track?: Track }>, force = false) {
    // Keep the engine + video render size matched to the composition resolution
    // (aspect-correct) before building/issuing this frame.
    this.syncResolution();
    // Every layer renders through the GPU composite now — video clips included
    // (their source.video.file entry outputs the host-injected decoded frame).
    const engineLayers = layers;
    this.engineLayerN = engineLayers.length;
    // NOTE: `hasContent` is updated only on COMMIT (below), never here from the target
    // — else during a Precise hold it flips true while the retained frame is still the
    // previous clip's, and the monitor draws that stale frame (the video→video flash).

    // Reconcile the main-thread video decode pumps with the active video clips
    // (each feeds its `source.video.file` entry). Cheap + diffed; the pump's own
    // rAF maps the live transport clock → frame, so this only handles the set.
    const videoDescs: VideoClipDesc[] = [];
    for (const l of engineLayers) {
      const d = videoDescFor(l.clip);
      if (d) videoDescs.push(d);
    }
    this.lastVideoDescs = videoDescs; // the Precise gate waits on these (the target)

    // Lookahead precache: pre-open + pre-decode video clips coming up soon (their ENTRY
    // frame — see VideoCompositor), so reaching them doesn't stall (Precise) or hiccup.
    const warmDescs = [...videoDescs];
    const seen = new Set(videoDescs.map((d) => d.clipId));
    for (const clip of store.videoClipsInWindow(store.positionBeat, store.positionBeat + LOOKAHEAD_BEATS)) {
      if (seen.has(clip.id)) continue;
      const d = videoDescFor(clip);
      if (d) { warmDescs.push(d); seen.add(clip.id); }
    }

    // ── "Precise" transport gate ───────────────────────────────────────────
    // Never composite a frame that isn't fully possible: hold the displayed composite
    // until every ACTIVE video clip has its current-beat frame decoded + injected.
    // `force` bypasses (a fail-safe timeout so a stuck decode can't freeze forever).
    const holding = shouldHoldPrecise({
      precise: store.transportMode === 'precise',
      force,
      activeVideoCount: videoDescs.length,
      ready: this.videoInputsReady(),
    });

    if (holding) {
      // Warm the target AND keep the clips CURRENTLY ON SCREEN alive (their textures
      // must not be torn down while we hold on them); leave the issued composite as-is.
      this.reconcilePump(pumpActiveSet(true, warmDescs, this.displayedVideoDescs));
      this.pendingPrecise = layers;
      if (!this.preciseTimer) {
        this.preciseTimer = setTimeout(() => {
          this.preciseTimer = null;
          const held = this.pendingPrecise;
          this.pendingPrecise = null;
          if (held) this.showComposite(held, /*force*/ true);
        }, 2500); // generous: only bail on a genuinely-stuck decode, not a slow cold one
      }
      return; // hold — the previous (ready) composite + its textures stay on screen
    }
    this.clearPreciseHold();

    // Fold the active engine layers into ONE composite sketch — rail base-curve
    // values + each clip's absolute start-seconds baked in (warp-aware). Shared
    // VERBATIM with the offline exporter (composite-frame.ts) so they render alike.
    const render = buildCompositeRenderAtBeat(store.positionBeat);

    if (!render) {
      // Issue the empty composite (clear the trace) BEFORE dropping pumps, so an on-
      // screen clip's texture isn't torn down while its composite is still displayed.
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
      this.reconcilePump(warmDescs);
      this.displayedVideoDescs = [];
      this.hasContent = false; // committed: background only → the monitor draws the backdrop
      return;
    }

    // Issue the target composite FIRST (its inputs are ready), THEN switch the pump to
    // the target set. ORDER MATTERS: dropping the old on-screen clips clears their
    // textures, and that must reach the worker AFTER the new composite — else a render
    // tick landing between the two messages shows the OLD composite with a torn-down
    // texture (the layers beneath flash through). This is the video→video flash.
    if (render.sig !== this.compositeSig) {
      this.compositeSig = render.sig;
      this.compositeKeys = (render.sketch.chain ?? []).map((e) => (e as { instance_key?: string }).instance_key ?? '');
      void this.ensureEngine().showComposite([
        { sketchId: COMPOSITE_ID, sketch: render.sketch, opts: render.opts },
      ]);
      this.refreshDeviceTraces();
      // The reissued sketch recreated the video instances (blank); re-inject each
      // active clip's current frame so a still image / paused first frame isn't blank.
      this.video?.reinjectActive();
    }
    this.reconcilePump(warmDescs);
    this.displayedVideoDescs = videoDescs;
    this.hasContent = true; // committed: a composite is on screen
  }

  /** Reconcile the video decode pump with `descs` (active target + lookahead). */
  private reconcilePump(descs: VideoClipDesc[]) {
    if (descs.length > 0 || this.video) {
      this.refreshWarpResolver();
      this.videoCompositor().setActiveClips(descs);
    }
  }

  destroy() {
    this.clearPreciseHold();
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
