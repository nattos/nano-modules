/**
 * App state types for the sketch editor.
 */

import type { Sketch } from '../sketch-types';

// --- Plugin info (from engine worker) ---

export interface PluginInfo {
  key: string;
  id: string;
  version: string;
  params: ParamInfo[];
  io: IOInfo[];
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

// --- Available effects (from module registration) ---

export interface AvailableEffect {
  id: string;           // "video.brightness_contrast" (module-relative semantic ID)
  name: string;         // "Brightness/Contrast"
  description: string;
  category: string;
  keywords: string[];
  /**
   * Effect kind. Defaults to a normal WASM-backed image `'effect'`. Distinct
   * kinds (e.g. `'dashboard'`) are handled specially by the UI — different card
   * rendering, no generic inspector. See column-group's util.dashboard case.
   */
  kind?: 'effect' | 'dashboard';
}

// --- Selectable system ---

import type { TemplateResult } from 'lit';
import type { TracePoint } from '../engine-types';

/**
 * Anything the user can click to inspect. Each selectable has a unique path
 * and an optional function to render its inspector content.
 */
export interface Selectable {
  /** Unique identifier, e.g. "effect/sketch_0/0/2" or "column/sketch_0/1". */
  path: string;
  /** Human-readable label shown in the inspector header. */
  label: string;
  /** Render the inspector panel content for this selection. */
  renderInspectorContent?(): TemplateResult | undefined;
  /**
   * The texture this selectable previews, if any. When selected, the main
   * sketch monitor switches to show it; with none selected (or a selection that
   * has no viewable texture, e.g. a scalar param), the monitor falls back to the
   * sketch's final output. See edit-tab's `edit_preview` registration.
   */
  traceTarget?: TracePoint['target'];
}

// --- Database state (persisted, undo/redo-able) ---

export interface DatabaseState {
  sketches: Record<string, Sketch>;
}

// --- User settings (persisted to IndexedDB, never in undo history) ---

/**
 * Per-user UI preferences. Lives in `appState.local.userSettings`. Auto-saved
 * via a debounced autorun. Never modified through `appController.mutate`.
 */
export interface UserSettings {
  /** Width in pixels of the IDE's left details panel. */
  ideLeftPanelWidth: number;
  /** Currently active left tab in the IDE. */
  ideLeftTab: 'explorer' | 'project_editor' | 'debug_info';
  /** Currently selected project id (`default:<effectId>` or `user:<uuid>`). */
  selectedProjectId: string | null;
  /** Scroll positions keyed by an arbitrary scope id. */
  scrollPositions: Record<string, number>;
  /** Whether the engine is paused. */
  paused: boolean;
  /** Resolume sketch-IDE: last active top tab (create/organize/edit). */
  activeTab: 'create' | 'organize' | 'edit';
  /** Resolume sketch-IDE: the sketch currently open in the edit tab. */
  editingSketchId: string | null;
}

// --- Local state (ephemeral, not in undo history) ---

export interface StagingInstance {
  pluginKey: string;
  moduleType: string;
  name: string;
  textureIn: boolean;
  textureOut: boolean;
}

export interface EngineStatus {
  fps: number;
  error: string | null;
  /** Traced output frames keyed by trace point ID. */
  tracedFrames: Record<string, ImageBitmap | null>;
  /** Incremented every time tracedFrames is updated, to force MobX reactivity. */
  frameGeneration: number;
  /** Per-sketch rail values from the executor, keyed by sketch ID. */
  sketchState: Record<string, any>;
  /** Live plugin state per instance, keyed by instance key. Updated per-frame from the worker. */
  pluginStates: Record<string, any>;
  /**
   * Latest per-frame debug stats. Only populated while the Debug Info
   * sidebar tab is active (the tab toggles `engine.setDebugMode`).
   */
  debugStats?: import('../engine-types').DebugStats;
  /**
   * Rolling buffer of recent console-log entries from any WASM
   * effect. Capped at the worker side; the UI keeps its own cap on
   * top so an off-tab session can't grow unbounded.
   */
  debugConsoleLog: import('../engine-types').DebugConsoleEntry[];
}

export interface LocalState {
  activeTab: 'create' | 'organize' | 'edit';
  plugins: PluginInfo[];
  availableEffects: AvailableEffect[];
  staging: StagingInstance[];
  selectedSketchId: string | null;
  editingSketchId: string | null;
  engine: EngineStatus;
  /** Whether tap configuration mode is active. */
  tappingMode: boolean;

  // --- Selection / Inspector ---
  /** Currently selected item (drives the inspector panel). */
  selection: Selectable | null;
  /**
   * Path queued for selection before the component has registered its Selectable.
   * When a component calls defineSelectable() with this path, the selection activates.
   */
  queuedSelectionPath: string | null;
  /**
   * Currently selected wire id (separate from `selection` — wires aren't
   * Selectables). A single click on a wire selects it (highlight); double-click
   * breaks it. Cleared when another wire or any Selectable is selected.
   */
  selectedWireId: string | null;

  // --- Effect IDE / cross-cutting persisted preferences ---
  /** UI preferences persisted to IndexedDB (never undo/redo-able). */
  userSettings: UserSettings;

  /**
   * True when this editor session is bound to a remote NanoBarrel FFGL
   * plugin (entered via `?barrel=ws://…`). Locks the UI into the
   * single-sketch edit view, hides the Create/Organize tabs, and
   * disables the dev-only auto-instantiation of demo effects. The
   * remote bridge is the source of truth for the sketch.
   */
  barrelMode: boolean;
}
