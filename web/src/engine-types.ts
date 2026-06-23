/**
 * Shared types for communication between the engine worker and main thread.
 */

import type { Sketch } from './sketch-types';

// --- Effect info (from module registration) ---

export interface EffectInfo {
  id: string;           // "debug.spinningtris" (module-relative semantic ID)
  name: string;         // "Spinning Triangles"
  description: string;
  category: string;
  keywords: string[];
}

// --- Plugin info (read-only snapshot for UI) ---

export interface PluginInfo {
  key: string;          // "com.nano.spinningtris@0"
  id: string;           // "com.nano.spinningtris"
  version: string;      // per-effect version (state::init), "major.minor.patch"
  moduleVersion?: string; // bundle/module version, "major.minor.patch"
  params: ParamInfo[];
  io: IOInfo[];
  /**
   * Raw schema fields object `{ [name]: { type, io?, default?, fields?, ... } }`.
   * Lets the UI render structured / GPU / vector ports that don't fit the
   * scalar ParamInfo model.
   */
  schema?: Record<string, any>;
  /**
   * Declarative capability tags from the schema's top-level `capabilities`
   * array (e.g. `['modulation_source', 'modulation_source_single']`). Classifies
   * what the effect is FOR. See `state::Capability` in host.h. Empty when none.
   */
  capabilities?: string[];
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
  /** Source effect's module ID (e.g. "color.saturate"). */
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
  // Drive the effect clock from an external (transport) time instead of the
  // free-running wall clock: elapsedTime := seconds, deltaTime := the change
  // since the last setTime. While the host keeps sending the SAME seconds (e.g.
  // transport paused) effects hold a static frame. Sending null reverts to the
  // free-running wall clock (the IDE's live preview).
  | { type: 'setTime'; seconds: number | null }
  // Advance exactly one frame (the IDE frame-step button). Meant to be sent
  // while paused; the worker simulates one tick with a fixed nominal dt.
  | { type: 'stepFrame' }
  | { type: 'setSketchInput'; sketchId: string; bitmap: ImageBitmap | null }
  // Bind a decoded frame to a specific instance's host-injected `frame` texture
  // field (the arrangement video pump → a `source.video.file` chain entry).
  // Keyed by the global instance key; pass null to clear.
  | { type: 'setInstanceTexture'; instanceKey: string; bitmap: ImageBitmap | null }
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
  // Main → worker: register an OS-resolved font face (sfnt bytes) under the
  // engine face key `key` for the shared text engine. The main thread resolves
  // these via Local Font Access in response to a `fontRequest`. `bytes` is
  // transferred.
  // An OS-resolved face: the worker derives the engine faceKey from
  // (family, weight, italic) and registers it into both the simple engine and
  // Blitz/fontique (which matches by family + weight + style).
  | { type: 'registerFont'; family: string; weight: number; italic: boolean; bytes: ArrayBuffer }
  // OS-resolved fallback face (Local Font Access, main thread) → the engine's
  // fallback chain, tagged with its CJK region `lang` (ja/ko/zh-Hant/zh-Hans).
  | { type: 'registerFallback'; lang: string; bytes: ArrayBuffer }
  | { type: 'debugDump' };

// --- Worker events (worker → main) ---

/**
 * Minimal per-frame state delta. `changed` holds only the top-level keys
 * (instance_key / plugin key) whose value differs from the last frame;
 * `removed` lists keys that disappeared. An all-empty diff (no changed
 * keys, no removed) means "nothing changed" and the main thread does no
 * work. The first frame after (re)connect naturally sends everything as
 * `changed` since the baseline starts empty.
 */
export interface StateDiff {
  changed: Record<string, any>;
  removed: string[];
}

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'state'; state: EngineState }
  | { type: 'effectsDiscovered'; effects: EffectInfo[] }
  | { type: 'frame'; fps: number; gpuTimeMs?: number; tracedFrames: Record<string, ImageBitmap>; sketchStateDiff: StateDiff; pluginStatesDiff: StateDiff; modulationDataDiff: StateDiff; debugStats?: DebugStats; debugConsoleLog?: DebugConsoleEntry[] }
  | { type: 'error'; message: string }
  // Worker → main: a text spec named a styled face the engine doesn't have;
  // asks the main thread to resolve it via Local Font Access and register it
  // under `req.key`.
  | { type: 'fontRequest'; req: FontRequest }
  | { type: 'debugDump'; data: any };

/** A request to resolve one styled face. `key` is the engine face-registry key
 *  (faceKey(family, weight, italic)) the resolved bytes must be registered under;
 *  family/weight/italic describe which OS face to pick. */
export interface FontRequest { key: string; family: string; weight: number; italic: boolean; }
