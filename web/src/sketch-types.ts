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
   * The single linear processing stack — the canonical store. Vertical position
   * encodes causality: a producer above a consumer feeds it same-frame; at/below
   * means 1-frame delay (which also breaks cycles → feedback).
   * `normalizeSketchChains` populates it (flattening any legacy `columns` blob
   * found on old persisted/remote JSON).
   */
  chain?: ChainEntry[];
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
 * A render-time view model over a sketch's single `chain` — NOT a stored shape.
 * The old multi-column data model was collapsed into one linear stack; the
 * `column-group` widget still renders against this `{ name, chain }` view, which
 * `synthesizes from `sketchChain(sketch)`. Implicit texture input/output wrap
 * the chain (they are not stored entries).
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

/** Flatten a legacy multi-column blob (old persisted/remote JSON) into the flat
 *  chain. `columns` is no longer part of the `Sketch` type, so we read it off
 *  the untyped value. */
function legacyColumnsChain(sketch: Sketch): ChainEntry[] {
  const columns = (sketch as any).columns as { chain?: ChainEntry[] }[] | undefined;
  return Array.isArray(columns) ? columns.flatMap(c => c?.chain ?? []) : [];
}

/**
 * Canonicalize a sketch into the single-`chain` model: flatten any legacy
 * `columns`, strip non-module entries (old explicit `texture_input` /
 * `texture_output`; texture I/O is implicit now), prune DANGLING wires (whose
 * `src`/`dest` instance is no longer in the chain — a silent executor no-op),
 * and de-duplicate colliding wire ids. Selection + the mod binding key off
 * `wire.id`, so two wires sharing an id select together and the editor patches
 * the wrong one; reassigning duplicates on ingest self-heals sketches saved
 * before ids were made collision-proof. Idempotent. Called on every sketch that
 * enters `appState.database` from an external source — IndexedDB load, remote
 * NanoBarrel snapshot, fixture creation.
 */
export function normalizeSketchChains(sketch: Sketch): Sketch {
  const chain = sketchChain(sketch).filter(e => e && (e as any).type === 'module') as ChainEntry[];
  const { columns, ...rest } = sketch as any;   // drop any legacy columns blob
  const result = { ...rest, chain } as Sketch;
  if (Array.isArray(result.wires)) {
    const keys = new Set(chain.map(e => e.instance_key));
    const seen = new Set<string>();
    result.wires = result.wires
      .filter(w => keys.has(w.src.instanceKey) && keys.has(w.dest.instanceKey))
      .map(w => {
        if (!seen.has(w.id)) { seen.add(w.id); return w; }
        let n = 2, nid = `${w.id}_${n}`;
        while (seen.has(nid)) nid = `${w.id}_${++n}`;
        seen.add(nid);
        return { ...w, id: nid };
      });
  }
  return result;
}

/**
 * The canonical single processing stack. Reads `sketch.chain`, falling back to
 * flattening a legacy `columns` blob so old persisted/remote sketches still load.
 */
export function sketchChain(sketch: Sketch): ChainEntry[] {
  if (Array.isArray(sketch.chain)) return sketch.chain;
  return legacyColumnsChain(sketch);
}

/**
 * Like {@link sketchChain} but for mutation: ensures `sketch.chain` exists
 * (seeding it from any legacy `columns`) and returns the live array so callers
 * can `push`/`splice` into the canonical stack. Use inside `mutate()` recipes.
 */
export function ensureChain(sketch: Sketch): ChainEntry[] {
  if (!Array.isArray(sketch.chain)) {
    sketch.chain = legacyColumnsChain(sketch);
  }
  return sketch.chain;
}

/** Read the chain entry at `chainIdx`, tolerating an undefined sketch. */
export function chainEntryAt(sketch: Sketch | undefined, chainIdx: number): ChainEntry | undefined {
  return sketch ? sketchChain(sketch)[chainIdx] : undefined;
}

// --- UI-only per-instance state ---

/**
 * Reserved key inside an instance's `state` for UI-only view state (card
 * collapse, etc.). Deliberately namespaced and OFF-LIMITS to the engine /
 * executor: it rides along in the serialized sketch, but nothing outside the UI
 * should ever read or write it. If the engine ever touches `__ui_only__`, that's
 * a bug — the distinct name makes such a leak obvious.
 */
export const UI_ONLY_KEY = '__ui_only__';

export interface UiOnlyState {
  /** Effect card collapsed in the IDE (fields + output traces hidden). */
  collapsed?: boolean;
}

/** Read the UI-only subtree for an instance. Never throws; empty default. */
export function uiOnlyState(sketch: Sketch | undefined, instanceKey: string): UiOnlyState {
  const v = sketch?.instances?.[instanceKey]?.state?.[UI_ONLY_KEY];
  return (v && typeof v === 'object') ? v as UiOnlyState : {};
}

/** Whether an effect card is collapsed (UI-only view state). */
export function isEffectCollapsed(sketch: Sketch | undefined, instanceKey: string): boolean {
  return uiOnlyState(sketch, instanceKey).collapsed === true;
}

// --- Wire modulation (mod / combine) ---

/**
 * Shaping curve applied to a remap's normalized value. `linear` is identity;
 * the rest are ease-in base curves (the `curveOut` slot mirrors them to ease-out
 * — see native/src/sketch/tap_mod.h for the exact formulas; the executor runs that
 * math on both web (executor.wasm) and native). `foldback` is special: instead of
 * clipping out-of-range input it reflects it back into range.
 */
export type TapCurve = 'linear' | 'quad' | 'circular' | 'power' | 'foldback';

/**
 * Range remapper applied to a scalar wire's value. All fields optional — an
 * absent `mod` (or absent sub-field) means pass-through.
 */
export interface TapMod {
  /** Multiply from 0 (out = in * scale). Default 1. Applied before `remap`. */
  scale?: number;
  /**
   * Optional drawn-curve shaper applied FIRST (before remap+scale), as a flat
   * number array `[x0,y0,e0, x1,y1,e1, ...]` of (x, y, ease) control points — the
   * same wire-format the mod.shaper.envelope effect uses. Edited with the shared
   * envelope graph editor. Absent / empty → pass-through. Evaluated by the
   * executor via envelope.h (see native/src/sketch/tap_mod.h).
   */
  envelope?: number[];
  /**
   * Optional temporal DELAY (seconds) applied to the final modulated value, AFTER
   * the pure envelope/remap/scale + magnitude fold and before smoothing. Transitive
   * (doesn't change the value's range). 0 / absent → pass-through. Stateful in the
   * executor (a per-input delay line); shares the mod.shaper.delay effect's math.
   */
  delay?: number;
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
 * How a scalar wire interprets its source value relative to the DEST field's
 * declared range — so a modulation source can drive a parameter without the
 * user hand-scaling it. See `applyMagnitude` in native/src/sketch/tap_mod.h for the exact math.
 * - `auto` (default): pick signed/unsigned from the SOURCE output field's
 *   optional `magnitude` schema declaration; unsigned when undeclared.
 * - `signed`: source treated as bipolar −1..1. If the source EXPLICITLY declares
 *   the opposite (unsigned [0,1]), the value is prescaled 0..1 → −1..1 (0→−1,
 *   1→1) so it spans the full bipolar range, rather than read at face value.
 * - `unsigned`: source treated as unipolar 0..1. If the source EXPLICITLY
 *   declares the opposite (signed −1..1), the value is prescaled −1..1 → 0..1
 *   (−1→0, 1→1) so the negative half maps into range.
 * - `absolute`: source is already in the dest's scale (legacy behavior — uses
 *   the manual `mod.shaper.remap`).
 *
 * The signed/unsigned prescale (resolved + applied in the executor's wire
 * normalization, so it's web/native identical) only fires against an EXPLICIT
 * opposite declaration; an undeclared source is taken at face value.
 *
 * Output schema fields may optionally declare `magnitude: 'signed' | 'unsigned'`
 * (read web-side from the schema; declared in the effects' C++ schema later).
 */
export type WireMagnitude = 'auto' | 'signed' | 'unsigned' | 'absolute';

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
  /** Scalar wires only: how the source value maps into the dest field's declared
   *  range. Default `auto`. See {@link WireMagnitude}. */
  magnitude?: WireMagnitude;
}

