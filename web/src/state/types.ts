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
}

export interface LocalState {
  activeTab: 'create' | 'organize' | 'edit';
  plugins: PluginInfo[];
  staging: StagingInstance[];
  selectedSketchId: string | null;
  editingSketchId: string | null;
  engine: EngineStatus;
}
