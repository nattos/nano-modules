/**
 * ArrEngine — the arrangement's render seam (Component C, PRD M2 vertical slice).
 *
 * Reuses the existing engine worker (via `EngineProxy`) to render a real clip
 * sketch through `executor.wasm` and deliver traced frames to the monitor. This
 * validates the executor render path inside the arrangement WITHOUT first
 * rebuilding the effect-bundle loading pipeline. The bespoke timeline-native
 * worker (global GPU sync across many clips) is a later, informed step once the
 * path is proven — the PRD's open question.
 *
 * Render recipe (mirrors `public/engine-test-runner.html`):
 *   loadModule(bundle) → instantiateEffect(id) → createSketch(anchor + chain)
 *   → setTracePoints([sketch_output]) → onTracedFrames → draw bitmap.
 */

import { EngineProxy } from '../../../engine-proxy';
import type { Sketch } from '../../../sketch-types';
import type { TracePoint, StateDiff, PluginInfo } from '../../../engine-types';

/** One parameter-automation write for a frame: the host's evaluated curve value
 *  for a composite instance's field, plus how it folds in (tap_mod vocab). */
export interface AutomationEntry {
  instance: string;
  field: string;
  value: number;
  combine?: string;
  magnitude?: string;
}

export interface ShowSketchOpts {
  /** Effect bundle to load first (e.g. 'com.nano.testonly', 'com.nano.core'). */
  bundle?: string;
  /** Additional bundles to load (a real chain spans multiple bundles). */
  bundles?: string[];
  /** Effect ids to instantiate before creating the sketch (the sketch's anchor
   *  + chain reference these as `<effectId>@<n>`). */
  effects?: string[];
  /** Trace id the frames arrive under (defaults to the sketch id). */
  traceId?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deep-plain a value so MobX observable contents (e.g. an rgb `[r,g,b]` array a
 * color editor wrote into device state) can cross the worker `postMessage`
 * boundary — `structuredClone` can't clone MobX Proxy arrays/objects, but a JSON
 * round-trip yields plain ones. (House rule: sanitize before postMessage.)
 */
function plainSketch(sketch: Sketch): Sketch {
  return JSON.parse(JSON.stringify(sketch)) as Sketch;
}

export class ArrEngine {
  private proxy: EngineProxy;
  private readyPromise: Promise<void>;

  /** Fired per traced frame: (traceId, bitmap). The receiver owns the bitmap. */
  onFrame: ((traceId: string, bitmap: ImageBitmap) => void) | null = null;
  /**
   * Fired once per rendered frame with ALL traced layers ({traceId → bitmap}).
   * Used by the compositor (multi-track output). When set it REPLACES the
   * per-frame `onFrame` fan-out (the receiver owns/closes every bitmap).
   */
  onFrameSet: ((frames: Record<string, ImageBitmap>) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  /** Per-frame GPU time (ms) the worker reported (diagnostic). */
  onGpuTime: ((gpuMs: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  /** Per-frame wire-modulation telemetry (keyed by engine instance key). */
  onModulationDataDiff: ((diff: StateDiff) => void) | null = null;
  /** Per-frame published instance state (outputs/broadcasts), for output traces. */
  onPluginStatesDiff: ((diff: StateDiff) => void) | null = null;
  /** Full plugin schemas as the worker discovers/warms them (for real editors). */
  onPlugins: ((plugins: PluginInfo[]) => void) | null = null;
  /** Union of effect ids discovered across loaded bundles (diagnostic). */
  readonly discovered = new Set<string>();
  /** Count of create/update sketch calls (diagnostic). */
  showCount = 0;
  /** Last debug stats (when debug mode on; diagnostic). */
  lastDebugStats: unknown = null;

  setDebugMode(on: boolean) { this.proxy.setDebugMode(on); }

  constructor(width = 640, height = 360) {
    this.proxy = new EngineProxy(width, height);
    this.proxy.onTracedFrames = (frames) => {
      if (this.onFrameSet) { this.onFrameSet(frames); return; }
      for (const id in frames) this.onFrame?.(id, frames[id]);
    };
    this.proxy.onFps = (fps) => this.onFps?.(fps);
    this.proxy.onGpuTime = (g) => this.onGpuTime?.(g);
    this.proxy.onError = (m) => this.onError?.(m);
    this.proxy.onModulationDataDiff = (diff) => this.onModulationDataDiff?.(diff);
    this.proxy.onPluginStatesDiff = (diff) => this.onPluginStatesDiff?.(diff);
    this.proxy.onStateUpdate = (state) => { if (state.plugins?.length) this.onPlugins?.(state.plugins); };
    this.proxy.onEffectsDiscovered = (effects) => {
      for (const e of effects) this.discovered.add(e.id);
    };
    this.proxy.onDebugStats = (s) => { this.lastDebugStats = s; };
    this.readyPromise = this.waitReady();
  }

  /** Resolves once the worker has booted (WebGPU device + executor ready). */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = setInterval(() => {
        if (this.proxy.ready) {
          clearInterval(check);
          resolve();
        } else if (Date.now() - t0 > 10_000) {
          clearInterval(check);
          reject(new Error('ArrEngine: worker init timeout'));
        }
      }, 50);
    });
  }

  /**
   * Render `sketch` and route its output to `onFrame` under `traceId`. Loads the
   * bundle + instantiates the referenced effects first (small inter-command
   * delays mirror the worker's async module-load ordering).
   */
  private shownSketches = new Set<string>();
  private loadedBundles = new Set<string>();
  private instantiated = new Set<string>();
  /** Stable trace slot the monitor draws from; re-targeted on each show. */
  private monitorTraceId = 'arr-monitor';
  /** Composite/layer output traces (set by show*); merged with device traces. */
  private baseTraces: TracePoint[] = [];
  /** Per-device texture traces (set by the bridge's TraceSource). */
  private extraTraces: TracePoint[] = [];

  private applyTraces() {
    this.proxy.setTracePoints([...this.baseTraces, ...this.extraTraces]);
  }

  /** Replace the per-device texture traces (merged with the base composite trace). */
  setExtraTracePoints(tps: TracePoint[]) {
    this.extraTraces = tps;
    this.applyTraces();
  }

  /**
   * Show `sketch` under `sketchId` and route its output to the monitor trace.
   * Each distinct content should use a distinct `sketchId` (a clip is its own
   * sketch); switching is a trace re-target, not a delete/recreate. Re-showing
   * the same id updates it in place. Bundle + effect loads are deduped.
   */
  async showSketch(sketchId: string, sketch: Sketch, opts: ShowSketchOpts = {}) {
    await this.readyPromise;
    sketch = plainSketch(sketch); // sanitize before any postMessage
    const bundles = [opts.bundle, ...(opts.bundles ?? [])].filter((b): b is string => !!b);
    for (const bundle of bundles) {
      if (this.loadedBundles.has(bundle)) continue;
      this.proxy.loadModule(bundle);
      this.loadedBundles.add(bundle);
      await delay(60);
    }
    for (const effectId of opts.effects ?? []) {
      if (this.instantiated.has(effectId)) continue;
      this.proxy.instantiateEffect(effectId);
      this.instantiated.add(effectId);
      await delay(60);
    }
    this.showCount++;
    if (this.shownSketches.has(sketchId)) {
      this.proxy.updateSketch(sketchId, sketch);
    } else {
      this.proxy.createSketch(sketchId, sketch);
      this.shownSketches.add(sketchId);
    }
    await delay(30);
    if (opts.traceId) this.monitorTraceId = opts.traceId;
    this.baseTraces = [{ id: this.monitorTraceId, target: { type: 'sketch_output', sketchId } }];
    this.applyTraces();
  }

  /**
   * Show a STACK of sketches as composite layers and trace them all. Each layer
   * is its own sketch (id = its key); the worker renders every traced layer per
   * frame and `onFrameSet` delivers them together for compositing in the given
   * order. Bundles/effects load deduped; create-or-update is per layer. Layers
   * absent from the list keep their sketch but stop tracing (call `deleteSketch`
   * to drop them). Passing `[]` clears all traces (monitor → placeholder).
   */
  async showComposite(layers: Array<{ sketchId: string; sketch: Sketch; opts?: ShowSketchOpts }>) {
    await this.readyPromise;
    // Sanitize each sketch before any postMessage (strip MobX proxies).
    layers = layers.map((l) => ({ ...l, sketch: plainSketch(l.sketch) }));
    const bundles = new Set<string>();
    for (const l of layers) {
      for (const b of [l.opts?.bundle, ...(l.opts?.bundles ?? [])]) if (b) bundles.add(b);
    }
    for (const bundle of bundles) {
      if (this.loadedBundles.has(bundle)) continue;
      this.proxy.loadModule(bundle);
      this.loadedBundles.add(bundle);
      await delay(60);
    }
    for (const l of layers) {
      if (this.shownSketches.has(l.sketchId)) {
        this.proxy.updateSketch(l.sketchId, l.sketch);
      } else {
        this.proxy.createSketch(l.sketchId, l.sketch);
        this.shownSketches.add(l.sketchId);
      }
    }
    this.showCount++;
    await delay(30);
    this.baseTraces = layers.map((l) => ({ id: l.sketchId, target: { type: 'sketch_output' as const, sketchId: l.sketchId } }));
    this.applyTraces();
  }

  /** Drop a composite layer's sketch entirely. */
  deleteSketch(sketchId: string) {
    if (!this.shownSketches.has(sketchId)) return;
    this.proxy.deleteSketch(sketchId);
    this.shownSketches.delete(sketchId);
  }

  /** Update an already-shown sketch in place (params / chain changes). */
  updateSketch(sketchId: string, sketch: Sketch) {
    this.proxy.updateSketch(sketchId, plainSketch(sketch));
  }

  /** Bind a decoded video frame to a `source.video.file` instance (null clears). */
  setInstanceTexture(instanceKey: string, bitmap: ImageBitmap | null) {
    this.proxy.setInstanceTexture(instanceKey, bitmap);
  }

  /** Push this frame's parameter automation (the host evaluated its curves at the
   *  playhead). The executor folds each entry into its field via tap_mod. */
  setAutomation(entries: AutomationEntry[]) {
    this.proxy.setAutomation(JSON.stringify(entries));
  }

  setPaused(paused: boolean) {
    this.proxy.setPaused(paused);
  }

  /** Drive the effect clock from a transport time (seconds), or null to free-run. */
  setTime(seconds: number | null) {
    this.proxy.setTime(seconds);
  }

  /** Advance exactly one frame while paused (for precise/offline stepping). */
  stepFrame() {
    this.proxy.stepFrame();
  }

  resize(width: number, height: number) {
    this.proxy.resize(width, height);
  }

  destroy() {
    this.proxy.destroy();
  }
}
