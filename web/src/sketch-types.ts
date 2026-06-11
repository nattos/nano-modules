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
  /**
   * Effect-IDE-only marker: this `user:` sketch was just materialized from a
   * default template and has not been edited yet. Hidden from explorer lists
   * and skipped by the project-store autosave. Cleared inside `mutate()` on
   * the first real edit.
   */
  isTemplate?: boolean;
}

/** Serialized state for a single module instance within a sketch. */
export interface InstanceState {
  module_type: string;
  /** The plugin's full state (inputs, outputs, internal). */
  state: Record<string, any>;
}

/**
 * A column is a linear chain of processing steps with sideband rails.
 *
 * Every column has an *implicit* texture input on top and an *implicit*
 * texture output on the bottom; they are NOT stored in `chain`. The
 * chain holds only the modules in between. Older sketches that
 * persisted explicit `texture_input` / `texture_output` chain entries
 * are normalised on load (see `normalizeSketch`).
 */
export interface SketchColumn {
  name: string;
  chain: ChainEntry[];
  /** Sideband rails available within this column. */
  rails?: Rail[];
}

/** A single entry in a processing chain. Always a module. */
export type ChainEntry = ModuleEntry;

/** A virtual module instance in the chain. */
export interface ModuleEntry {
  type: 'module';
  module_type: string;
  instance_key: string;
  /** @deprecated Use sketch.instances[instance_key].state instead. */
  params?: Record<string, number>;
  /** Rail connections for this module instance. */
  taps?: Tap[];
  /** Engine-level per-parameter options (smoothing, …), keyed by field path. */
  fieldOptions?: Record<string, FieldOptions>;
}

/**
 * Engine-level options attached to a single input parameter — a generic region
 * for per-field behaviors layered ON TOP of the parameter's value (and any tap
 * modulation). `smoothing` is the first such option; future options sit beside it.
 */
export interface FieldOptions {
  smoothing?: ParamSmoothing;
}

/**
 * Linear smoothing of changes to a scalar-float parameter. Explicit timer: when
 * the (post-modulation) target value changes, the timer resets and the effective
 * value linearly interpolates from its current value to the new target over
 * `duration` seconds, then HOLDS. Linear — not exponential — so it reaches the
 * target in finite time without indefinite decay / subnormal drift / rubber-banding.
 */
export interface ParamSmoothing {
  enabled: boolean;
  /** Linear ramp duration in seconds. */
  duration: number;
}

/**
 * Strip any legacy `texture_input` / `texture_output` chain entries so a
 * sketch matches the implicit-I/O model. Idempotent. Called on every
 * sketch that enters `appState.database` from an external source —
 * IndexedDB load, remote NanoBarrel snapshot, fixture creation, etc.
 *
 * Mutates the column chains in place if `inPlace` is true; otherwise
 * returns a shallow-cloned sketch with cleaned chains.
 */
export function normalizeSketchChains(sketch: Sketch): Sketch {
  const columns = sketch.columns.map(col => {
    const cleaned = col.chain.filter(e => e && (e as any).type === 'module');
    if (cleaned.length === col.chain.length) return col;
    return { ...col, chain: cleaned as ChainEntry[] };
  });
  if (columns.every((c, i) => c === sketch.columns[i])) return sketch;
  return { ...sketch, columns };
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

/**
 * Shaping curve applied to a remap's normalized value. `linear` is identity;
 * the rest are ease-in base curves (the `curveOut` slot mirrors them to ease-out
 * — see web/src/tap-mod.ts / native/src/sketch/tap_mod.h for the exact, lock-step
 * formulas that web and native MUST share for pixel parity). `foldback` is
 * special: instead of clipping out-of-range input it reflects it back into range.
 */
export type TapCurve = 'linear' | 'quad' | 'circular' | 'power' | 'foldback';

/**
 * Per-tap range remapper. Applied to float-rail values only: BEFORE writing
 * (write taps) or AFTER reading (read taps). All fields optional — an absent
 * `mod` (or absent sub-field) means today's pass-through behavior.
 */
export interface TapMod {
  /** Multiply from 0 (out = in * scale). Default 1. Applied before `remap`. */
  scale?: number;
  remap?: {
    inMin: number;
    inMax: number;
    outMin: number;
    outMax: number;
    /** Clip the normalized input to [0,1] (ignored when `curveIn`/`curveOut` is `foldback`). */
    saturate?: boolean;
    /** Ease-in shaping on the input side. Default `linear`. */
    curveIn?: TapCurve;
    /** Ease-out shaping on the output side. Default `linear`. */
    curveOut?: TapCurve;
    /** Exponent for `power` curves. Default 2. */
    exponent?: number;
  };
}

/** How a write tap combines its (modded) value into the rail's current frame value. */
export type TapCombine = 'replace' | 'mix' | 'add' | 'mul';

/** Connects a module's field to a rail. */
export interface Tap {
  railId: string;
  /** Field path in instance state (e.g. "params/0", "output", "texture_out/0"). */
  fieldPath: string;
  direction: 'read' | 'write';
  /** Range remapper (float rails only). Read taps: after read; write taps: before write. */
  mod?: TapMod;
  /** Write taps only: how to combine into the rail (default `replace`). */
  combine?: TapCombine;
  /** Factor for `combine === 'mix'` (lerp toward the new value). Default 1. */
  mixFactor?: number;
}
