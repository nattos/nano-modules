/**
 * Engine proxy — main-thread wrapper around the engine worker.
 * Receives ImageBitmap frames for display and provides a clean API for the UI.
 */

import type { WorkerCommand, WorkerEvent, EngineState, EffectInfo, TracePoint, ParamValue, DebugStats, DebugConsoleEntry, FontRequest, CompFrameInfo } from './engine-types';
import type { Sketch } from './sketch-types';

export class EngineProxy {
  private worker: Worker;
  private _ready = false;
  private _barrelMode = false;

  onStateUpdate: ((state: EngineState) => void) | null = null;
  onEffectsDiscovered: ((effects: EffectInfo[]) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  /// Estimated GPU busy-time this frame, in milliseconds (CPU-fence proxy).
  /// Drives the headroom readout against the user's target framerate.
  onGpuTime: ((ms: number) => void) | null = null;
  onTracedFrames: ((frames: Record<string, ImageBitmap>) => void) | null = null;
  onSketchStateDiff: ((diff: import('./engine-types').StateDiff) => void) | null = null;
  onPluginStatesDiff: ((diff: import('./engine-types').StateDiff) => void) | null = null;
  /// Per-frame modulation telemetry (modulated inputs → effective value + band).
  onModulationDataDiff: ((diff: import('./engine-types').StateDiff) => void) | null = null;
  /// Per-frame debug counters (effects executed, dispatches, fused
  /// runs, etc.). Only fires when the worker is in debug mode.
  onDebugStats: ((stats: DebugStats) => void) | null = null;
  /// Aggregated console-log batch from this frame's WASM effects.
  /// Only fires when the worker is in debug mode and the frame
  /// produced any log output.
  onDebugConsoleLog: ((entries: DebugConsoleEntry[]) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  /// Per-frame composition-executor report (comp mode). Fired BEFORE
  /// onTracedFrames so hasContent is current when the composite bitmap lands.
  onCompInfo: ((info: CompFrameInfo) => void) | null = null;
  /// The worker's text engine saw a spec naming a styled face it doesn't have.
  /// The main thread resolves it via Local Font Access and calls registerFont().
  onFontRequest: ((req: FontRequest) => void) | null = null;
  /// Sidechannel-bus channel metadata (fires only on change, not per frame).
  onSidechannels: ((channels: Record<string, import('./engine-types').SidechannelInfo>) => void) | null = null;
  onTriggerRails: ((rails: Record<string, Record<string, import('./engine-types').TriggerChannelInfo>>) => void) | null = null;
  private debugDumpResolve: ((data: any) => void) | null = null;
  private fieldVisReqId = 0;
  private fieldVisResolvers = new Map<number, (hidden: string[] | null) => void>();

  constructor(width: number, height: number, barrelMode = false) {
    this.worker = new Worker(
      new URL('./engine-worker.ts', import.meta.url),
      { type: 'module' },
    );
    this._barrelMode = barrelMode;

    this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
      const event = e.data;
      switch (event.type) {
        case 'ready':
          this._ready = true;
          break;
        case 'state':
          this.onStateUpdate?.(event.state);
          break;
        case 'effectsDiscovered':
          this.onEffectsDiscovered?.(event.effects);
          break;
        case 'frame':
          this.onFps?.(event.fps);
          if (event.gpuTimeMs !== undefined) this.onGpuTime?.(event.gpuTimeMs);
          if (event.comp) this.onCompInfo?.(event.comp);
          this.onTracedFrames?.(event.tracedFrames);
          this.onSketchStateDiff?.(event.sketchStateDiff);
          this.onPluginStatesDiff?.(event.pluginStatesDiff);
          this.onModulationDataDiff?.(event.modulationDataDiff);
          if (event.debugStats) this.onDebugStats?.(event.debugStats);
          if (event.debugConsoleLog && event.debugConsoleLog.length > 0) {
            this.onDebugConsoleLog?.(event.debugConsoleLog);
          }
          break;
        case 'sidechannels':
          this.onSidechannels?.(event.channels);
          break;
        case 'triggerRails':
          this.onTriggerRails?.(event.rails);
          break;
        case 'error':
          this.onError?.(event.message);
          console.error('[engine]', event.message);
          break;
        case 'fontRequest':
          this.onFontRequest?.(event.req);
          break;
        case 'fieldVisibility': {
          const resolve = this.fieldVisResolvers.get(event.reqId);
          if (resolve) {
            this.fieldVisResolvers.delete(event.reqId);
            resolve(event.hidden);
          }
          break;
        }
        case 'debugDump':
          this.debugDumpResolve?.(event.data);
          this.debugDumpResolve = null;
          break;
      }
    };

    this.send({ type: 'init', width, height, barrelMode });
  }

  get ready() { return this._ready; }
  get barrelMode() { return this._barrelMode; }

  private send(cmd: WorkerCommand, transfer?: Transferable[]) {
    if (transfer) this.worker.postMessage(cmd, transfer);
    else this.worker.postMessage(cmd);
  }

  resize(width: number, height: number) {
    this.send({ type: 'resize', width, height });
  }

  /** Drive the effect clock from an external time (transport), or null to free-run. */
  setTime(seconds: number | null) {
    this.send({ type: 'setTime', seconds });
  }

  loadModule(moduleType: string) {
    this.send({ type: 'loadModule', moduleType });
  }

  instantiateEffect(effectId: string) {
    this.send({ type: 'instantiateEffect', effectId });
  }

  /**
   * Resolve which fields `moduleType` hides for `state`, via the effect's static
   * `eval_visibility` evaluator (no live instance required). Resolves to the
   * hidden-field set, or `null` if the effect has no static evaluator (or the
   * query times out). Caller should fall back to live/last-known visibility on
   * null. Memoization is the caller's concern.
   */
  requestFieldVisibility(moduleType: string, state: Record<string, unknown>): Promise<string[] | null> {
    const reqId = ++this.fieldVisReqId;
    return new Promise((resolve) => {
      this.fieldVisResolvers.set(reqId, resolve);
      // Safety net: never leak a pending resolver if the worker drops the reply.
      setTimeout(() => {
        if (this.fieldVisResolvers.delete(reqId)) resolve(null);
      }, 5000);
      this.send({ type: 'requestFieldVisibility', reqId, moduleType, state });
    });
  }

  changeInstanceType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    this.send({ type: 'changeInstanceType', sketchId, colIdx, chainIdx, newModuleType });
  }

  createSketch(sketchId: string, sketch: Sketch) {
    this.send({ type: 'createSketch', sketchId, sketch });
  }

  updateSketch(sketchId: string, sketch: Sketch) {
    this.send({ type: 'updateSketch', sketchId, sketch });
  }

  deleteSketch(sketchId: string) {
    this.send({ type: 'deleteSketch', sketchId });
  }

  setParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue) {
    this.send({ type: 'setParam', sketchId, colIdx, chainIdx, paramKey, value });
  }

  setTracePoints(tracePoints: TracePoint[]) {
    this.send({ type: 'setTracePoints', tracePoints });
  }

  setPaused(paused: boolean) {
    this.send({ type: 'setPaused', paused });
  }

  /** Advance exactly one frame (intended while paused). */
  stepFrame() {
    this.send({ type: 'stepFrame' });
  }

  /**
   * Inject a frame source for a sketch's `texture_input` chain entry.
   * Pass `null` to clear. The bitmap is transferred (consumed on the main
   * thread); the caller is responsible for re-decoding if it needs to
   * push another frame.
   */
  setSketchInput(sketchId: string, bitmap: ImageBitmap | null) {
    if (bitmap) {
      this.send({ type: 'setSketchInput', sketchId, bitmap }, [bitmap]);
    } else {
      this.send({ type: 'setSketchInput', sketchId, bitmap: null });
    }
  }

  /**
   * Inject the shared "test input" frame used as the fallback input for every
   * sketch without an anchor / per-sketch input (offline/playground). Pass
   * `null` to clear. The bitmap is transferred (consumed on the main thread).
   */
  setGlobalInput(bitmap: ImageBitmap | null) {
    if (bitmap) {
      this.send({ type: 'setGlobalInput', bitmap }, [bitmap]);
    } else {
      this.send({ type: 'setGlobalInput', bitmap: null });
    }
  }

  /** Bind a decoded frame to an instance's host `frame` field (null to clear). */
  setInstanceTexture(instanceKey: string, bitmap: ImageBitmap | null) {
    if (bitmap) {
      this.send({ type: 'setInstanceTexture', instanceKey, bitmap }, [bitmap]);
    } else {
      this.send({ type: 'setInstanceTexture', instanceKey, bitmap: null });
    }
  }

  reloadWasm(wasmUrl: string) {
    this.send({ type: 'reloadWasm', wasmUrl });
  }

  /** Register an OS-resolved font face (sfnt bytes) under the engine face `key`
   *  with the worker's text engine. The buffer is transferred (consumed here). */
  registerFont(family: string, weight: number, italic: boolean, bytes: ArrayBuffer) {
    this.send({ type: 'registerFont', family, weight, italic, bytes }, [bytes]);
  }

  /** Register an OS-resolved FALLBACK face (sfnt bytes) into the engine's
   *  fallback chain, tagged with its CJK region `lang`. The buffer is
   *  transferred (consumed here). */
  registerFallback(lang: string, bytes: ArrayBuffer) {
    this.send({ type: 'registerFallback', lang, bytes }, [bytes]);
  }

  /**
   * Test-only knob — switches the engine's fusion planner between auto
   * (production), force-on (every fusion-eligible stage takes the
   * dispatcher path, even single-stage runs), and force-off (no
   * fusion). Used by per-effect E2E tests to verify the standalone and
   * fused paths produce identical pixels.
   */
  /** Push this frame's parameter automation (JSON array of
   *  {instance,field,value,combine,magnitude}) to the executor. */
  setAutomation(json: string) {
    this.send({ type: 'setAutomation', json });
  }

  setFusionMode(mode: 'auto' | 'force-on' | 'force-off') {
    this.send({ type: 'setFusionMode', mode });
  }

  // ── Composition executor (arrangement comp mode) ──
  compMode(on: boolean) { this.send({ type: 'compMode', on }); }
  compLoadDoc(json: string) { this.send({ type: 'compLoadDoc', json }); }
  compControl(msg: Omit<Extract<WorkerCommand, { type: 'compControl' }>, 'type'>) {
    this.send({ type: 'compControl', ...msg });
  }
  compOp(msg: Omit<Extract<WorkerCommand, { type: 'compOp' }>, 'type'>) {
    this.send({ type: 'compOp', ...msg });
  }

  /**
   * Toggle debug-stats / console-log broadcasting. The Debug Info
   * sidebar tab calls `setDebugMode(true)` when it's the active left
   * tab and `setDebugMode(false)` when it's not — keeping the worker
   * → main payload empty when nobody's looking.
   */
  setDebugMode(on: boolean) {
    this.send({ type: 'setDebugMode', on });
  }

  debugDump(): Promise<any> {
    return new Promise(resolve => {
      this.debugDumpResolve = resolve;
      this.send({ type: 'debugDump' });
    });
  }

  destroy() {
    this.worker.terminate();
  }
}
