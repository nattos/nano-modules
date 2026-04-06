/**
 * Shared types for communication between the engine worker and main thread.
 */

import type { Sketch } from './sketch-types';

// --- Plugin info (read-only snapshot for UI) ---

export interface PluginInfo {
  key: string;          // "com.nattos.spinningtris@0"
  id: string;           // "com.nattos.spinningtris"
  version: string;
  params: ParamInfo[];
  io: IOInfo[];
}

export interface ParamInfo {
  index: number;
  name: string;
  type: number;
  defaultValue: number;
}

export interface IOInfo {
  index: number;
  name: string;
  kind: number;   // 0=texture_input, 1=texture_output, 2=data_output
  role: number;   // 0=primary, 1=secondary
}

// --- Engine state snapshot (worker → main) ---

export interface EngineState {
  plugins: PluginInfo[];
  sketches: Record<string, Sketch>;
}

// --- Worker commands (main → worker) ---

export type WorkerCommand =
  | { type: 'init'; width: number; height: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'loadModule'; moduleType: string }
  | { type: 'createSketch'; sketchId: string; sketch: Sketch }
  | { type: 'updateSketch'; sketchId: string; sketch: Sketch }
  | { type: 'setParam'; sketchId: string; instanceKey: string; index: number; value: number };

// --- Worker events (worker → main) ---

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'state'; state: EngineState }
  | { type: 'frame'; fps: number; bitmap: ImageBitmap }
  | { type: 'error'; message: string };
