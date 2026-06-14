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
  /**
   * The single linear processing stack. Vertical position encodes causality:
   * a producer above a consumer feeds it same-frame; at/below means 1-frame
   * delay (which also breaks cycles → feedback). Canonical;
   * `normalizeSketchChains` populates it, flattening any legacy `columns`.
   */
  chain?: ChainEntry[];
  /** @deprecated legacy multi-column layout; flattened into `chain`. Still
   *  required until the controller/UI finish migrating to `chain`. */
  columns: SketchColumn[];
  /**
   * Direct field-to-field connections. A wire
   * connects a producer's output field to a consumer's input field, addressed by
   * `instance_key` so it survives reordering. Causality is POSITIONAL: if the
   * source executes before the dest (above it in the single stack) the value is
   * read same-frame; otherwise it's read 1-frame-delayed (which also breaks
   * cycles → feedback). Scalar wires may carry a `mod`/`combine` (reused from the
   * tap-mod math). Texture/struct wires carry only the connection.
   */
  wires?: Wire[];
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
 * A column is a linear chain of processing steps.
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
  const chain = sketchChain(sketch).filter(e => e && (e as any).type === 'module') as ChainEntry[];
  // `chain` is canonical. `columns` is kept during the transition because the
  // controller/UI still read it; the worker re-normalizes on every ingest so the
  // executor's `chain` stays fresh after a columns mutation.
  return { ...sketch, chain };
}

/**
 * The canonical single processing stack, flattening any legacy multi-column
 * layout. Use this instead of `sketch.columns` / `sketch.chain` directly so old
 * (columns-based) and new (chain-based) sketches both work.
 */
export function sketchChain(sketch: Sketch): ChainEntry[] {
  if (Array.isArray(sketch.chain)) return sketch.chain;
  return (sketch.columns ?? []).flatMap(c => c.chain ?? []);
}

// --- Wire modulation (mod / combine) ---

/**
 * Shaping curve applied to a remap's normalized value. `linear` is identity;
 * the rest are ease-in base curves (the `curveOut` slot mirrors them to ease-out
 * — see web/src/tap-mod.ts / native/src/sketch/tap_mod.h for the exact, lock-step
 * formulas that web and native MUST share for pixel parity). `foldback` is
 * special: instead of clipping out-of-range input it reflects it back into range.
 */
export type TapCurve = 'linear' | 'quad' | 'circular' | 'power' | 'foldback';

/**
 * Range remapper applied to a scalar wire's value. All fields optional — an
 * absent `mod` (or absent sub-field) means pass-through.
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

/** How a scalar wire's (modded) value folds into the dest param when multiple
 *  wires target it. */
export type TapCombine = 'replace' | 'mix' | 'add' | 'mul';

/**
 * A direct connection from a producer output field to a consumer input field —
 * the replacement for taps+rails. Endpoints are addressed by `instance_key` +
 * field path so wires survive reordering/insert/delete. Delay is inferred from
 * execution position (see `Sketch.wires`); the UI indicates delayed wires.
 */
export interface Wire {
  id: string;
  /** Producer side: the instance whose output feeds the wire, and its output field. */
  src: { instanceKey: string; field: string };
  /** Consumer side: the instance receiving the value, and its input field. */
  dest: { instanceKey: string; field: string };
  /** Scalar wires only: range remap applied to the value (reuses tap-mod math). */
  mod?: TapMod;
  /** Scalar wires only: how to fold into the dest param when multiple wires target it. */
  combine?: TapCombine;
  /** Factor for `combine === 'mix'`. Default 1. */
  mixFactor?: number;
}

