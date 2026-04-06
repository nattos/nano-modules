/**
 * Data model for sketches — virtual module chains with sideband rail routing.
 *
 * Stored in the state document at /sketches/{sketch_id}.
 */

/** A sketch is a processing graph anchored to a real FFGL instance. */
export interface Sketch {
  anchor: string | null;
  columns: SketchColumn[];
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
  params: Record<string, number>;
  /** Rail connections for this module instance. */
  taps?: Tap[];
}

/** Marks a texture output point in the chain. */
export interface TextureOutputEntry {
  type: 'texture_output';
  id: string;
}

// --- Sideband Rails ---

/** A named data channel within a column. */
export interface Rail {
  id: string;
  name?: string;
  dataType: 'float' | 'texture';
}

/** Connects a module's field to a rail. */
export interface Tap {
  railId: string;
  /** Field path in instance state (e.g. "params/0", "output", "texture_out/0"). */
  fieldPath: string;
  direction: 'read' | 'write';
}
