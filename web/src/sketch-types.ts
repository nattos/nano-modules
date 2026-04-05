/**
 * Data model for sketches — virtual module chains anchored to real instances.
 *
 * Stored in the state document at /sketches/{sketch_id}.
 * Read/written via the standard get_at / apply_client_patch mechanism.
 */

/** A sketch is a processing graph anchored to a real FFGL instance. */
export interface Sketch {
  /** Key of the real instance this sketch is anchored to, or null for standalone. */
  anchor: string | null;
  /** Processing columns (currently only the first "main" column is executed). */
  columns: SketchColumn[];
}

/** A column is a linear chain of processing steps. */
export interface SketchColumn {
  name: string;
  chain: ChainEntry[];
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
  /** Module type ID, e.g. "com.nattos.brightness_contrast". */
  module_type: string;
  /** Unique key for this virtual instance, e.g. "virtual_bc@0". */
  instance_key: string;
  /** Parameter values keyed by param name or index. */
  params: Record<string, number>;
}

/** Marks a texture output point in the chain. */
export interface TextureOutputEntry {
  type: 'texture_output';
  id: string;
}
