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
  id: string;           // "com.nattos.brightness_contrast"
  name: string;         // "Brightness/Contrast"
  description: string;
  category: string;
  keywords: string[];
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
}
