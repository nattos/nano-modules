/**
 * Engine proxy — main-thread wrapper around the engine worker.
 * Receives ImageBitmap frames for display and provides a clean API for the UI.
 */

import type { WorkerCommand, WorkerEvent, EngineState, EffectInfo, TracePoint } from './engine-types';
import type { Sketch } from './sketch-types';

export class EngineProxy {
  private worker: Worker;
  private _ready = false;

  onStateUpdate: ((state: EngineState) => void) | null = null;
  onEffectsDiscovered: ((effects: EffectInfo[]) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  onTracedFrames: ((frames: Record<string, ImageBitmap>) => void) | null = null;
  onSketchState: ((sketchState: Record<string, any>) => void) | null = null;
  onPluginStates: ((pluginStates: Record<string, any>) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private debugDumpResolve: ((data: any) => void) | null = null;

  constructor(width: number, height: number) {
    this.worker = new Worker(
      new URL('./engine-worker.ts', import.meta.url),
      { type: 'module' },
    );

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
          this.onTracedFrames?.(event.tracedFrames);
          this.onSketchState?.(event.sketchState);
          this.onPluginStates?.(event.pluginStates);
          break;
        case 'error':
          this.onError?.(event.message);
          console.error('[engine]', event.message);
          break;
        case 'debugDump':
          this.debugDumpResolve?.(event.data);
          this.debugDumpResolve = null;
          break;
      }
    };

    this.send({ type: 'init', width, height });
  }

  get ready() { return this._ready; }

  private send(cmd: WorkerCommand, transfer?: Transferable[]) {
    if (transfer) this.worker.postMessage(cmd, transfer);
    else this.worker.postMessage(cmd);
  }

  resize(width: number, height: number) {
    this.send({ type: 'resize', width, height });
  }

  loadModule(moduleType: string) {
    this.send({ type: 'loadModule', moduleType });
  }

  instantiateEffect(effectId: string) {
    this.send({ type: 'instantiateEffect', effectId });
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

  setParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: number) {
    this.send({ type: 'setParam', sketchId, colIdx, chainIdx, paramKey, value });
  }

  setTracePoints(tracePoints: TracePoint[]) {
    this.send({ type: 'setTracePoints', tracePoints });
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
