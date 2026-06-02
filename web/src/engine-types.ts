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
  /**
   * Raw schema fields object `{ [name]: { type, io?, default?, fields?, ... } }`.
   * Lets the UI render structured / GPU / vector ports that don't fit the
   * scalar ParamInfo model.
   */
  schema?: Record<string, any>;
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

// --- Debug stats (frame-scoped instrumentation) ---

/**
 * Per-frame counters from the sketch executor. Surfaced when the
 * worker is in debug mode (setDebugMode(true)). Lets the Debug Info
 * UI quantify the win from stage coalescing — `effectsExecuted` is
 * the pre-fusion dispatch count, `gpuDispatches` is what actually
 * went to the GPU, `dispatchesSaved` is the difference.
 */
export interface DebugStats {
  /** Total module entries processed across every sketch+column. */
  effectsExecuted: number;
  /** Stages that ran their own dispatch (one render() per stage). */
  standaloneDispatches: number;
  /** Number of fused runs (each run is one combined compute pass). */
  fusedRuns: number;
  /** Sum of stages folded into fused runs. */
  fusedStages: number;
  /** Compute passes saved by fusion (= fusedStages − fusedRuns). */
  dispatchesSaved: number;
  /** Total compute passes issued (= standaloneDispatches + fusedRuns). */
  gpuDispatches: number;
  /** Stateless passthrough stages skipped via the identity predicate. */
  identitySkipped: number;
}

/**
 * One console-log entry collected from any WASM effect this frame.
 * Aggregated across all sketches/columns for the Debug Info viewer.
 */
export interface DebugConsoleEntry {
  /** Source effect's instance key (so the UI can group/filter). */
  instanceKey: string;
  /** Source effect's module ID (e.g. "video.saturate"). */
  moduleId: string;
  /** Engine-relative timestamp (seconds). */
  timestamp: number;
  /** "log" | "warn" | "error". */
  level: string;
  /** The user-visible message. */
  message: string;
  /** Optional structured payload from console_log_structured. */
  data?: any;
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

/// Allowed runtime types for a parameter value crossing the worker boundary.
export type ParamValue = number | number[] | string | boolean;

export type WorkerCommand =
  // `barrelMode: true` puts the worker into editor-only mode: no per-frame
  // simulateTick, no warmupEffects (so no WasmHost ever gets instantiated),
  // no broadcastState (the editor's plugin list comes from the WS bridge
  // instead). The render loop's rAF still fires so paused/resumed state
  // and frame-event posts stay alive for any UI bookkeeping that depends
  // on them.
  | { type: 'init'; width: number; height: number; barrelMode?: boolean }
  | { type: 'resize'; width: number; height: number }
  | { type: 'loadModule'; moduleType: string }
  | { type: 'instantiateEffect'; effectId: string }
  | { type: 'changeInstanceType'; sketchId: string; colIdx: number; chainIdx: number; newModuleType: string }
  | { type: 'createSketch'; sketchId: string; sketch: Sketch }
  | { type: 'updateSketch'; sketchId: string; sketch: Sketch }
  | { type: 'deleteSketch'; sketchId: string }
  // value is `number` for scalar fields and `number[]` for vec2/vec3/vec4
  // / RGB(A) color fields. Bool/event fields use 0/1 numbers; string
  // fields use a JS string. Anything else is invalid.
  | { type: 'setParam'; sketchId: string; colIdx: number; chainIdx: number; paramKey: string; value: ParamValue }
  | { type: 'setTracePoints'; tracePoints: TracePoint[] }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'restart' }
  | { type: 'setSketchInput'; sketchId: string; bitmap: ImageBitmap | null }
  | { type: 'reloadWasm'; wasmUrl: string }
  // Test-only: route fusion-eligible stages through the dispatcher
  // ('force-on'), back to the standalone path ('force-off'), or use
  // production defaults ('auto'). Used by per-effect tests to verify
  // byte-identity between the standalone and fused paths.
  | { type: 'setFusionMode'; mode: 'auto' | 'force-on' | 'force-off' }
  // Toggle debug-stats collection. When on, the worker tracks
  // per-frame counters (effects executed, dispatches issued, fused
  // runs, dispatches saved) and ships them on each frame event.
  // Default off — collection is essentially free, but the broadcast
  // overhead is paid only when the user opens the Debug Info tab.
  | { type: 'setDebugMode'; on: boolean }
  | { type: 'debugDump' };

// --- Worker events (worker → main) ---

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'state'; state: EngineState }
  | { type: 'effectsDiscovered'; effects: EffectInfo[] }
  | { type: 'frame'; fps: number; tracedFrames: Record<string, ImageBitmap>; sketchState: Record<string, any>; pluginStates: Record<string, any>; debugStats?: DebugStats; debugConsoleLog?: DebugConsoleEntry[] }
  | { type: 'error'; message: string }
  | { type: 'debugDump'; data: any };
