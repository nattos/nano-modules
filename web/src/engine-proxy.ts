/**
 * Engine proxy — main-thread wrapper around the engine worker.
 * Provides a clean API for the UI to interact with the engine.
 */

import type { WorkerCommand, WorkerEvent, EngineState } from './engine-types';
import type { Sketch } from './sketch-types';

export class EngineProxy {
  private worker: Worker;
  private _ready = false;

  onStateUpdate: ((state: EngineState) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
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
        case 'frame':
          this.onFps?.(event.fps);
          break;
        case 'error':
          this.onError?.(event.message);
          console.error('[engine]', event.message);
          break;
      }
    };

    // Transfer the OffscreenCanvas to the worker
    const offscreen = canvas.transferControlToOffscreen();
    this.send({ type: 'init', canvas: offscreen }, [offscreen]);
  }

  get ready() { return this._ready; }

  private send(cmd: WorkerCommand, transfer?: Transferable[]) {
    if (transfer) this.worker.postMessage(cmd, transfer);
    else this.worker.postMessage(cmd);
  }

  loadModule(moduleType: string) {
    this.send({ type: 'loadModule', moduleType });
  }

  createSketch(sketchId: string, sketch: Sketch) {
    this.send({ type: 'createSketch', sketchId, sketch });
  }

  updateSketch(sketchId: string, sketch: Sketch) {
    this.send({ type: 'updateSketch', sketchId, sketch });
  }

  setParam(sketchId: string, instanceKey: string, index: number, value: number) {
    this.send({ type: 'setParam', sketchId, instanceKey, index, value });
  }

  destroy() {
    this.worker.terminate();
  }
}
