/**
 * Data model for sketches — virtual module chains with sideband rail routing.
 *
 * Stored in the state document at /sketches/{sketch_id}.
 */

/** The ID of the special unassigned bucket sketch that holds modules not yet placed in a real sketch. */
export const BUCKET_SKETCH_ID = '__unassigned__';

/** A sketch is a processing graph anchored to a real FFGL instance. */
export interface Sketch {
  anchor: string | null;
  columns: SketchColumn[];
  /** Cross-cutting rails shared across all columns (sketch-scoped). */
  rails?: Rail[];
  /** Per-instance state, keyed by instance_key. Canonical source of truth for all field values. */
  instances?: Record<string, InstanceState>;
}

/** Serialized state for a single module instance within a sketch. */
export interface InstanceState {
  module_type: string;
  /** The plugin's full state (inputs, outputs, internal). */
  state: Record<string, any>;
}

/** A column is a linear chain of processing steps with sideband rails. */
export interface SketchColumn {
  name: string;
  chain: ChainEntry[];
  /** Sideband rails available within this column. */
  rails?: Rail[];
}

/** A single entry in a processing chain. */
export type ChainEntry =
  | TextureInputEntry
  | ModuleEntry
  | TextureOutputEntry;

/** Marks a texture input point in the chain. */
export interface TextureInputEntry {
  type: 'texture_input';
  id: string;
}

/** A virtual module instance in the chain. */
export interface ModuleEntry {
  type: 'module';
  module_type: string;
  instance_key: string;
  /** @deprecated Use sketch.instances[instance_key].state instead. */
  params?: Record<string, number>;
  /** Rail connections for this module instance. */
  taps?: Tap[];
}

/** Marks a texture output point in the chain. */
export interface TextureOutputEntry {
  type: 'texture_output';
  id: string;
}

// --- Sideband Rails ---

/**
 * Rail payload type. Scalar shorthands are preserved for backward compat;
 * structured payloads carry the writer's schema so readers can validate
 * assignability at tap-binding time and so struct handoff knows which
 * leaves are textures or GPU buffers.
 */
export type RailDataType =
  | 'float'
  | 'texture'
  | { kind: 'struct'; schema: Record<string, any> };

/** A named data channel within a column. */
export interface Rail {
  id: string;
  name?: string;
  dataType: RailDataType;
}

/** Connects a module's field to a rail. */
export interface Tap {
  railId: string;
  /** Field path in instance state (e.g. "params/0", "output", "texture_out/0"). */
  fieldPath: string;
  direction: 'read' | 'write';
}
