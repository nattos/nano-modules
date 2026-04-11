/**
 * Shared types for communication between the engine worker and main thread.
 */

import type { Sketch } from './sketch-types';

// --- Effect info (from module registration) ---

export interface EffectInfo {
  id: string;           // "generator.spinningtris" (module-relative semantic ID)
  name: string;         // "Spinning Triangles"
  description: string;
  category: string;
  keywords: string[];
}

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
  type: number;       // 0=bool, 1=event, 10=standard, 11=option, 13=integer, 100=text
  defaultValue: number;
  min: number;
  max: number;
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
  sketchState: Record<string, any>;
}

// --- Trace points ---

export interface TracePoint {
  id: string;
  target:
    | { type: 'sketch_output'; sketchId: string }
    | { type: 'plugin_output'; pluginKey: string }
    | { type: 'chain_entry'; sketchId: string; colIdx: number; chainIdx: number; side: 'input' | 'output' };
  /** Optional capture size override. If omitted, captures at source texture resolution. */
  size?: { width: number; height: number };
}

// --- Worker commands (main → worker) ---

export type WorkerCommand =
  | { type: 'init'; width: number; height: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'loadModule'; moduleType: string }
  | { type: 'instantiateEffect'; effectId: string }
  | { type: 'createSketch'; sketchId: string; sketch: Sketch }
  | { type: 'updateSketch'; sketchId: string; sketch: Sketch }
  | { type: 'setParam'; sketchId: string; colIdx: number; chainIdx: number; paramKey: string; value: number }
  | { type: 'setTracePoints'; tracePoints: TracePoint[] }
  | { type: 'debugDump' };

// --- Worker events (worker → main) ---

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'state'; state: EngineState }
  | { type: 'effectsDiscovered'; effects: EffectInfo[] }
  | { type: 'frame'; fps: number; tracedFrames: Record<string, ImageBitmap>; sketchState: Record<string, any>; pluginStates: Record<string, any> }
  | { type: 'error'; message: string }
  | { type: 'debugDump'; data: any };
