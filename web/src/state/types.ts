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
}

// --- Selectable system ---

import type { TemplateResult } from 'lit';

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
}

// --- Database state (persisted, undo/redo-able) ---

export interface DatabaseState {
  sketches: Record<string, Sketch>;
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
  /** Currently selected field path for tap configuration, e.g. "sketch_0/0/2/brightness". */
  selectedFieldPath: string | null;

  // --- Selection / Inspector ---
  /** Currently selected item (drives the inspector panel). */
  selection: Selectable | null;
  /**
   * Path queued for selection before the component has registered its Selectable.
   * When a component calls defineSelectable() with this path, the selection activates.
   */
  queuedSelectionPath: string | null;
  /** Registry of all currently-mounted selectables, keyed by path. */
  selectableRegistry: Map<string, Selectable>;
}
