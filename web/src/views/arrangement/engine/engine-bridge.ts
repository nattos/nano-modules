/**
 * EngineBridge — the app-wide seam between the arrangement store and ONE live
 * `ArrEngine`, whose worker runs the in-wasm COMPOSITION EXECUTOR (comp_* ABI):
 * the worker owns the transport, timeline evaluation, sketch building, the
 * Precise gate, and rendering. Steady-state playback sends ZERO per-frame
 * main→worker messages.
 *
 * Responsibilities:
 *  - Own a single `ArrEngine`, booted **lazily** on first renderable selection
 *    (so pages/tests that never render don't spawn a worker + WebGPU device).
 *  - MIRROR the composition document into the worker (diff-pushed on
 *    `store.docRev`) and send transport/gate commands on change; the playhead
 *    mirrors BACK via the per-frame comp report (`handleCompInfo`).
 *  - Run the video decode pump on the worker-reported active set and push
 *    edge-triggered per-clip frame readiness to the native Precise gate.
 *  - RETAIN the latest composite frame (`engineComposite()`) and notify a
 *    listener (`setOnComposite`) each frame; the monitor draws that composite.
 *  - An optional capture tap (Component D live thumbnails) sees the composite.
 *
 * The OFFLINE EXPORT path deliberately does NOT go through this bridge: it
 * drives a SECOND worker running its own comp executor (export-renderer.ts),
 * paused and stepped seek-by-seek — same in-wasm builder, so export ≡ preview.
 */

import { ArrEngine } from './arr-engine';
import type { CompFrameInfo } from '../../../engine-types';
import { debugPerf } from '../state/debug-perf';
import { clipInstanceKey } from './instance-keys';
import { VideoCompositor, videoDescFor, type VideoClipDesc } from './video-compositor';
import { makeWarpClock } from './warp-clock';
import { videoInputsReady as gateVideoReady } from './precise-gate';
import { store } from '../state/store';
import { deviceIsSource } from '../model/composition';
import type { TracePoint } from '../../../engine-types';
import { EFFECT_BUNDLES } from '../../../effect-bundles';
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
  /** store.docRev of the last document mirror pushed to the comp executor. */
  private sentDocRev = -1;
  private sentClipTiming: boolean | null = null;
  private sentPrecise: boolean | null = null;
  private sentPlaying: boolean | null = null;
  private sentLoopSig = '';
  /** Edge-triggered per-clip readiness pushed to the native Precise gate. */
  private sentVideoReady = new Map<string, boolean>();
  /** The comp transport's last mirrored playhead (echo detection for scrubs). */
  private mirroredBeat = Number.NaN;
  /** Ignore mirror-backs briefly after sending a seek (in-flight echo guard). */
  private seekQuietUntil = 0;
  /** The worker-reported decode-pump active set (comp mode owns the union). */
  private compPumpDescs: VideoClipDesc[] | null = null;
  /** Latest comp-executor frame report (comp mode; diagnostic/tests). */
  lastCompInfo: CompFrameInfo | null = null;
  /** The last warm (active + lookahead) desc set — the readiness scan's clip
   *  list, retained so pushes can run OUTSIDE the reactive showComposite path. */
  private lastWarmDescs: VideoClipDesc[] = [];
  /** Current engine render size (composition aspect, capped). */
  private renderW = 640;
  private renderH = 360;
  private onCompositeCb: CompositeListener | null = null;
  private tap: FrameTap | null = null;

  /** Video clips of the TARGET composite (current beat) — the Precise gate waits on
   *  these to be decoded + injected before issuing. */
  private lastVideoDescs: VideoClipDesc[] = [];
  /** Video clips of the composite CURRENTLY ON SCREEN. Kept alive in the decode pump
   *  while a Precise hold is pending so the held frame's textures aren't torn down
   *  (else the held composite goes transparent → the layers beneath flash through). */
  private displayedVideoDescs: VideoClipDesc[] = [];
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
  /** `store.warpEpoch` the warp resolver was last installed for. Reset to -1 when the
   *  pump is (re)created so the next refresh re-installs onto the fresh compositor. */
  private warpResolverEpoch = -1;

  /** Keep the pump's warp-aware beat→seconds resolver in sync with the composition,
   *  so video timing seeks through warped regions the same way the grid draws them.
   *  Gated on the cheap `warpEpoch` COUNTER — this runs on every composite reconcile
   *  (i.e. every frame + every edit); rebuilding a JSON warp signature here each time
   *  stalled the playhead during a slider drag. `warpEpoch` doesn't bump on param /
   *  transform edits, so a slider drag is a no-op here. */
  private refreshWarpResolver() {
    if (this.warpResolverEpoch === store.warpEpoch) return;
    const clock = makeWarpClock(store.composition);
    // videoCompositor() may CREATE the pump (which resets warpResolverEpoch to -1),
    // so stamp the epoch AFTER installing the resolver.
    this.videoCompositor().setTimeResolver((beat) => clock.secondsAt(beat));
    this.warpResolverEpoch = store.warpEpoch;
  }

  private videoCompositor(): VideoCompositor {
    if (!this.video) {
      this.warpResolverEpoch = -1; // fresh pump → force the next refresh to install the resolver
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
    // Static field-visibility resolver: lets the inspector resolve conditional
    // field visibility for off-playhead / multi-selected clips (whose instances
    // never execute) via the effect's `eval_visibility` evaluator. See store
    // `ensureFieldVisibility` + the adapter's static-hidden overlay.
    store.visibilityResolver = (moduleType, state) => e.evaluateVisibility(moduleType, state);
    // Eagerly load every shipping effect bundle (shared list, testonly excluded) so
    // all effects are reachable — not just those a clip already references.
    void e.warmBundles(EFFECT_BUNDLES);
    e.onCompInfo = (info) => this.handleCompInfo(info);
    void e.compEnable(COMPOSITE_ID);
    this.engine = e;
    return e;
  }

  /** Per-frame comp-executor report (comp mode): hasContent + structure-change
   *  bookkeeping the plain path derives locally, plus the playhead mirror-back
   *  (the comp transport owns the beat while playing). */
  private handleCompInfo(info: CompFrameInfo) {
    this.lastCompInfo = info;
    this.hasContent = info.hasContent;
    if (info.chainKeys) {
      this.compositeKeys = info.chainKeys;
      this.refreshDeviceTraces();
      // A structure change recreated the source.video.file instances (their
      // bound textures dropped) — re-inject the active frames (plain-path twin:
      // showComposite's !sameStructure branch).
      this.video?.reinjectActive();
    }
    if (info.layerTargets !== undefined) {
      // The build's `__layer__` resolution — mixer strips resolve their
      // modulation bands through it (the blend key churns with the active clip).
      try { store.setLayerTargets(JSON.parse(info.layerTargets)); } catch { /* keep prev */ }
    }
    if (info.videoDescs !== undefined) {
      try {
        this.compPumpDescs = JSON.parse(info.videoDescs) as VideoClipDesc[];
        // Apply immediately — worker reports arrive independent of any MobX
        // reaction, and a hold's fresh pump set must open its clips NOW (the
        // hold is waiting on exactly those decodes).
        this.reconcilePump(this.compPumpDescs);
      } catch { /* malformed — keep the previous set */ }
    }
    // Mirror the advancing playhead back to the store while playing. Skipped
    // briefly after WE send a seek — an in-flight report from before the seek
    // would otherwise yank the playhead back (the echo problem).
    if (store.playing && performance.now() >= this.seekQuietUntil) {
      this.mirroredBeat = info.positionBeat;
      store.setPosition(info.positionBeat);
    }
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
    // A video frame just landed — the native Precise gate may now have all its
    // inputs: push the readiness edge immediately.
    this.pushCompVideoReadiness();
  }

  /** True when every active video clip has its current-beat frame injected (see
   *  precise-gate.videoInputsReady for the invariants). */
  private videoInputsReady(): boolean {
    const beat = store.positionBeat;
    const bpm = store.composition.meta.baseBPM;
    return gateVideoReady(this.lastVideoDescs, !!this.video, (id) => this.video!.clipReady(id, beat, bpm));
  }

  /** True when there are active video clips at the playhead still waiting on a
   *  decoded frame — i.e. the disk is busy (regardless of transport mode). Drives
   *  the transport bar's "D" light. */
  decodePending(): boolean {
    return this.lastVideoDescs.length > 0 && !this.videoInputsReady();
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

  /** Boot the engine eagerly (idempotent) so it warms every shipping bundle and
   *  discovers their schemas — populating `store.enginePlugins`, which the
   *  add-effect palette + inspector editors read. Without this an EMPTY timeline
   *  (no renderable selection to trigger the lazy boot) would show no effects. */
  warm() { this.ensureEngine(); }

  /** Effect ids discovered across loaded bundles (diagnostic). */
  discoveredEffects(): string[] {
    return this.engine ? [...this.engine.discovered] : [];
  }

  setDebugMode(on: boolean) { this.engine?.setDebugMode(on); }
  debugStats(): unknown { return this.engine?.lastDebugStats ?? null; }

  get ready(): Promise<void> | null {
    return this.engine?.ready ?? null;
  }

  /**
   * Reflect the timeline at the playhead into the engine — the monitor's
   * reactive entry (tracked reads in its render() re-fire this on edits /
   * playhead moves). The full sync ALSO runs from the app's unconditional rAF
   * ticker (compTick): while the native Precise gate holds, the beat freezes,
   * nothing observable changes, and this reaction never fires.
   */
  showComposite() {
    this.compSyncFromStore();
  }

  /**
   * Comp-mode full store→worker sync, derived from the store at the CURRENT
   * playhead. Runs from BOTH the monitor's reactive showComposite AND the
   * app's unconditional rAF ticker (compTick): while the native gate holds,
   * the beat is frozen, no observable changes, and the reaction never fires —
   * anything applied only there (pump reconcile, transport diffs, readiness)
   * would starve, deadlocking the hold. Everything inside is diffed, so the
   * double per-frame call is cheap.
   */
  private compSyncFromStore() {
    this.syncResolution();
    const layers = store.compositeLayersAtBeat(store.positionBeat);
    this.engineLayerN = layers.length;
    const videoDescs: VideoClipDesc[] = [];
    for (const l of layers) {
      const d = videoDescFor(l.clip);
      if (d) videoDescs.push(d);
    }
    this.lastVideoDescs = videoDescs; // decodePending()/inputsReady() read these
    const warmDescs = [...videoDescs];
    const seen = new Set(videoDescs.map((d) => d.clipId));
    for (const clip of store.videoClipsInWindow(store.positionBeat, store.positionBeat + LOOKAHEAD_BEATS)) {
      if (seen.has(clip.id)) continue;
      const d = videoDescFor(clip);
      if (d) { warmDescs.push(d); seen.add(clip.id); }
    }
    this.syncComp(videoDescs, warmDescs);
  }

  /**
   * Comp-mode per-frame sync (D2): diff-push the document + transport + gate
   * state to the worker's composition executor, and keep the decode pump on
   * the worker-reported active set (which folds in the hold union).
   */
  private syncComp(videoDescs: VideoClipDesc[], warmDescs: VideoClipDesc[]) {
    const e = this.ensureEngine();

    if (store.docRev !== this.sentDocRev) {
      this.sentDocRev = store.docRev;
      e.compLoadDoc(JSON.stringify(store.composition));
    }
    const timing = store.clipAutoTiming === 'loop';
    if (timing !== this.sentClipTiming) {
      this.sentClipTiming = timing;
      e.compControl({ op: 'clipTiming', loopMode: timing });
    }
    const precise = store.transportMode === 'precise';
    if (precise !== this.sentPrecise) {
      this.sentPrecise = precise;
      e.compControl({ op: 'mode', precise });
    }
    const loopSig = `${store.loopEnabled}|${store.loopStartBeat}|${store.loopEndBeat}`;
    if (loopSig !== this.sentLoopSig) {
      this.sentLoopSig = loopSig;
      e.compControl({
        op: 'loop', enabled: store.loopEnabled,
        startBeat: store.loopStartBeat, endBeat: store.loopEndBeat,
      });
    }
    if (store.playing !== this.sentPlaying) {
      this.sentPlaying = store.playing;
      e.compControl({ op: store.playing ? 'play' : 'pause' });
      // (Re)starting playback re-anchors from wherever the playhead sits.
      this.mirroredBeat = store.positionBeat;
      e.compControl({ op: 'seek', beat: store.positionBeat });
      this.seekQuietUntil = performance.now() + 150;
    }
    // A playhead move NOT explained by the mirror-back is a user scrub.
    if (store.positionBeat !== this.mirroredBeat) {
      this.mirroredBeat = store.positionBeat;
      e.compControl({ op: 'seek', beat: store.positionBeat });
      this.seekQuietUntil = performance.now() + 150;
    }

    // Edge-triggered per-clip readiness for the native Precise gate.
    this.lastWarmDescs = warmDescs;
    this.pushCompVideoReadiness();

    // The worker's pump set (target ∪ displayed while holding) wins; fall back
    // to the local warm set until the first report lands.
    this.reconcilePump(this.compPumpDescs ?? warmDescs);
    this.displayedVideoDescs = videoDescs;
  }

  /**
   * Scan the warm clips' frame readiness and push CHANGES to the native Precise
   * gate. MUST run on an unconditional cadence, not just from showComposite:
   * the monitor's showComposite is a MobX reaction, and while the native gate
   * HOLDS the beat is frozen — nothing observable changes, the reaction never
   * fires, and a ready=true edge would never be sent (a hold deadlock the 2.5s
   * force-bypass only papers over one frame at a time). Called from the app's
   * rAF tick (compTick) and synchronously on every frame injection.
   */
  private pushCompVideoReadiness() {
    const e = this.engine;
    if (!e) return;
    const bpm = store.composition.meta.baseBPM;
    const liveIds = new Set<string>();
    for (const d of this.lastWarmDescs) {
      liveIds.add(d.clipId);
      const ready = !!this.video?.clipReady(d.clipId, store.positionBeat, bpm);
      if (this.sentVideoReady.get(d.clipId) !== ready) {
        this.sentVideoReady.set(d.clipId, ready);
        e.compControl({ op: 'videoReady', clipId: d.clipId, ready });
      }
    }
    for (const id of [...this.sentVideoReady.keys()]) {
      if (!liveIds.has(id)) {
        // A clip left the warm set — mark unready so a re-entry never trusts a
        // stale flag, then forget it.
        if (this.sentVideoReady.get(id)) e.compControl({ op: 'videoReady', clipId: id, ready: false });
        this.sentVideoReady.delete(id);
      }
    }
  }

  /** Comp-mode per-rAF upkeep, called from the app's transport ticker (an
   *  unconditional rAF — deliberately NOT a MobX reaction; see
   *  compSyncFromStore). No-op outside comp mode / before the engine boots
   *  (boot stays lazy via the monitor's reactive path). */
  compTick() {
    if (!this.engine) return; // boot stays lazy via the monitor's reactive path
    this.compSyncFromStore();
  }

  /** Reconcile the video decode pump with `descs` (active target + lookahead). */
  private reconcilePump(descs: VideoClipDesc[]) {
    if (descs.length > 0 || this.video) {
      this.refreshWarpResolver();
      this.videoCompositor().setActiveClips(descs);
    }
  }

  destroy() {
    this.video?.destroy();
    this.video = null;
    this.engine?.destroy();
    this.engine = null;
    this.sentDocRev = -1;
    this.sentClipTiming = null;
    this.sentPrecise = null;
    this.sentPlaying = null;
    this.sentLoopSig = '';
    this.sentVideoReady.clear();
    this.mirroredBeat = Number.NaN;
    this.compPumpDescs = null;
    this.onCompositeCb = null;
    this.tap = null;
    this.engineLayerN = 0;
    this.compositeFrame?.close();
    this.compositeFrame = null;
  }
}

/** App-wide singleton (mirrors the `store` singleton). Engine boots lazily. */
export const engineBridge = new EngineBridge();
