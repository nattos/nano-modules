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
import type { TracePoint, StateDiff } from '../../../engine-types';

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

export class ArrEngine {
  private proxy: EngineProxy;
  private readyPromise: Promise<void>;

  /** Fired per traced frame: (traceId, bitmap). The receiver owns the bitmap. */
  onFrame: ((traceId: string, bitmap: ImageBitmap) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  /** Per-frame wire-modulation telemetry (keyed by engine instance key). */
  onModulationDataDiff: ((diff: StateDiff) => void) | null = null;
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
      for (const id in frames) this.onFrame?.(id, frames[id]);
    };
    this.proxy.onFps = (fps) => this.onFps?.(fps);
    this.proxy.onError = (m) => this.onError?.(m);
    this.proxy.onModulationDataDiff = (diff) => this.onModulationDataDiff?.(diff);
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

  /**
   * Show `sketch` under `sketchId` and route its output to the monitor trace.
   * Each distinct content should use a distinct `sketchId` (a clip is its own
   * sketch); switching is a trace re-target, not a delete/recreate. Re-showing
   * the same id updates it in place. Bundle + effect loads are deduped.
   */
  async showSketch(sketchId: string, sketch: Sketch, opts: ShowSketchOpts = {}) {
    await this.readyPromise;
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
    const trace: TracePoint = {
      id: this.monitorTraceId,
      target: { type: 'sketch_output', sketchId },
    };
    this.proxy.setTracePoints([trace]);
  }

  /** Update an already-shown sketch in place (params / chain changes). */
  updateSketch(sketchId: string, sketch: Sketch) {
    this.proxy.updateSketch(sketchId, sketch);
  }

  setPaused(paused: boolean) {
    this.proxy.setPaused(paused);
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
