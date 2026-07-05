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
   * Engine (runtime) version that serialized this sketch, as [major, minor,
   * patch]. A MINOR bump signals a serialization-incompatible engine change.
   * Stamped at save time; migrations/fallbacks are a later concern — for now we
   * just record it. See ENGINE_VERSION in version.ts.
   */
  engineVersion?: [number, number, number];
  /**
   * Effect-IDE-only marker: this `user:` sketch was just materialized from a
   * default template and has not been edited yet. Hidden from explorer lists
   * and skipped by the project-store autosave. Cleared inside `mutate()` on
   * the first real edit.
   */
  isTemplate?: boolean;
  /**
   * Per-sketch output format override: internal render resolution (multiplier
   * of the host output size, or fixed) and working bit depth. Absent = 1× at
   * 8-bit (today's exact behavior — the UI DELETES the key when everything is
   * back at defaults). Honored inside the shared C++ executor
   * (sketch_executor.cpp parseOutputFormat — keep the derivation rules in
   * `resolveInternalResolution` below in lock-step), so it applies identically
   * in barrel, playground, effect-IDE and arrangement clips.
   */
  outputFormat?: SketchOutputFormat;
}

/** Internal-resolution override — multiplier of the host size, or fixed. */
export type SketchResolutionOverride =
  | { mode: 'multiplier'; scale: number }            // presets 0.25/0.5/1/2/4, or custom
  | { mode: 'fixed'; width: number; height: number };

/** See Sketch.outputFormat. */
export interface SketchOutputFormat {
  resolution?: SketchResolutionOverride;   // absent = 1x (host size)
  bitDepth?: 8 | 16;                       // absent = 8
}

/**
 * The internal render size the engine will use for `fmt` at host size
 * (hostW × hostH). TS twin of parseOutputFormat in
 * native/src/sketch/sketch_executor.cpp — keep byte-identical rules:
 * multiplier scale clamped to [0.1, 8], dimensions rounded (lround) then
 * clamped to [8, 8192] (WebGPU core maxTextureDimension2D), malformed input
 * falls back to the host size.
 */
export function resolveInternalResolution(
    fmt: SketchOutputFormat | undefined,
    hostW: number, hostH: number): { width: number; height: number } {
  const out = { width: hostW, height: hostH };
  const res = fmt?.resolution;
  if (!res || typeof res !== 'object') return out;
  const clampDim = (v: number): number => {
    if (!(v > 0)) return 0;
    return Math.min(8192, Math.max(8, Math.round(v)));
  };
  if (res.mode === 'multiplier') {
    let s = typeof res.scale === 'number' && res.scale > 0 ? res.scale : 1;
    s = Math.min(8, Math.max(0.1, s));
    const w = clampDim(hostW * s), h = clampDim(hostH * s);
    if (w > 0 && h > 0) { out.width = w; out.height = h; }
  } else if (res.mode === 'fixed') {
    const w = clampDim(res.width), h = clampDim(res.height);
    if (w > 0 && h > 0) { out.width = w; out.height = h; }
  }
  return out;
}

/** The sketch's working bit depth (8 unless outputFormat opts into 16F). */
export function sketchBitDepth(sketch: Sketch): 8 | 16 {
  return sketch.outputFormat?.bitDepth === 16 ? 16 : 8;
}

/**
 * Coerce a possibly-malformed output format into safe, persistable values.
 * Non-finite numbers (NaN/±Infinity) serialize to JSON `null`, which the native
 * parser reads back as a non-number and — pre-hardening — aborted on. Drop any
 * resolution whose numbers aren't finite and positive, and collapse to
 * `undefined` when only defaults survive (so untouched sketches stay
 * byte-identical). Called on every write and on ingest.
 */
export function sanitizeOutputFormat(fmt?: SketchOutputFormat): SketchOutputFormat | undefined {
  if (!fmt || typeof fmt !== 'object') return undefined;
  const out: SketchOutputFormat = {};
  if (fmt.bitDepth === 16) out.bitDepth = 16;
  const res = fmt.resolution;
  if (res && typeof res === 'object') {
    if (res.mode === 'multiplier') {
      const s = res.scale;
      // scale === 1 is the identity default — dropped, not persisted.
      if (Number.isFinite(s) && s > 0 && s !== 1) out.resolution = { mode: 'multiplier', scale: s };
    } else if (res.mode === 'fixed') {
      const { width: w, height: h } = res;
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        out.resolution = { mode: 'fixed', width: w, height: h };
      }
    }
  }
  return out.resolution || out.bitDepth ? out : undefined;
}

/** True when `fmt` encodes only defaults (1× multiplier, 8-bit) — the UI
 *  deletes the key in that case so untouched sketches stay byte-identical. */
export function isDefaultOutputFormat(fmt?: SketchOutputFormat): boolean {
  if (!fmt) return true;
  if (fmt.bitDepth === 16) return false;
  const res = fmt.resolution;
  if (!res) return true;
  return res.mode === 'multiplier' && (!(res.scale > 0) || res.scale === 1);
}

/** Serialized state for a single module instance within a sketch. */
export interface InstanceState {
  module_type: string;
  /** The plugin's full state (inputs, outputs, internal). */
  state: Record<string, any>;
  /**
   * Versions captured when this instance was created, each [major, minor,
   * patch]: `effect` is the effect's own state::init version, `module` is its
   * bundle version. A MINOR bump of either signals the stored `state` may be
   * serialization-incompatible with the current build. Recorded only; we worry
   * about migrations later.
   */
  version?: { module: [number, number, number]; effect: [number, number, number] };
  /**
   * Per-slot help-text state, keyed by slot path (a `helpField` name or a
   * `@group/<id>` group-help path). `scope` selects which layer is SHOWN outside
   * editing — 'local' shows this sketch's `text`, 'global' shows the browser-wide
   * override (STORE_FIELD_DOCS) falling back to the effect-authored default.
   * Absent entry ⇒ default scope ('global') and no local override.
   */
  help?: Record<string, InstanceHelp>;
}

/** Per-slot help-text override stored in the sketch (see InstanceState.help). */
export interface InstanceHelp {
  /** Which layer is shown outside editing. Defaults to 'global' when absent. */
  scope?: 'global' | 'local';
  /** The sketch-local markdown override (only meaningful for scope 'local'). */
  text?: string;
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
  // Scrub any malformed output-format numbers a prior session may have persisted
  // (e.g. a NaN scale round-tripped through JSON.stringify → null) so they can't
  // reach the executor. Delete the key entirely when nothing non-default remains.
  if ('outputFormat' in result) {
    const clean = sanitizeOutputFormat(result.outputFormat);
    if (clean) result.outputFormat = clean; else delete result.outputFormat;
  }
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

// ──────────────────────────────────────────────────────────────────────────
// Special module types + wire-connect descriptor
//
// These live here (not in state/controller) so widgets like <column-group> can
// reference them without importing the AppController/appState singletons — the
// seam that lets the column card be reused outside the effect IDE. controller.ts
// re-exports them for back-compat.
// ──────────────────────────────────────────────────────────────────────────

/** The dashboard module: N relay knobs exposed as named sketch inputs. */
export const DASHBOARD_MODULE_TYPE = 'util.dashboard';

/** The inverse of the dashboard: N OUTPUT traces internal wires write INTO
 *  (the sketch's exposed scalar outputs). Mirrors util.dashboard's relay fields. */
export const SKETCH_OUTPUT_MODULE_TYPE = 'util.sketch_output';

/**
 * Synthetic schema defs for the ENGINE-RESERVED per-effect keys. They aren't
 * plugin schema fields (the executor strips `__` keys before the plugin and
 * consumes them itself: wet/dry opacity + the bypass gate), but wires and
 * automation may target them — these defs supply the dest range contract
 * ([0,1]; bypass thresholds at >= 0.5 executor-side) and let the wire UI treat
 * them like ordinary float inputs.
 */
export const RESERVED_FIELD_DEFS: Record<string, { type: string; io: number; min: number; max: number; default: number }> = {
  __opacity__: { type: 'float', io: 1, min: 0, max: 1, default: 1 },
  __bypass__: { type: 'float', io: 1, min: 0, max: 1, default: 0 },
};

/**
 * Composite blend mode names, indexed to match the native `composite.blend`
 * (video_blend) enum exactly — the index IS the mode value. Used both by the
 * arrangement's layer blend and the per-effect `__blend__` reserved key (the
 * executor's wet/dry pass routes non-Normal modes through the same math as
 * composite.blend — see native host_blend.h). Keep in lock-step with
 * native/wasm_modules/video_blend/main.cpp.
 */
export const BLEND_MODE_NAMES = [
  'Normal', 'Add', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'Dodge', 'Burn', 'Hard Light', 'Soft Light', 'Difference', 'Exclusion',
  'Subtract', 'Divide', 'Linear Burn',
] as const;

/** Identifies one end of a drag-to-connect operation. */
export interface FieldConnectInfo {
  sketchId: string;
  colIdx: number;
  chainIdx: number;
  fieldPath: string;
  isOutput: boolean;
  /** Viewport Y used to decide writer vs reader when both fields are same direction. */
  viewportY: number;
  /** Schema definition for this field (null if legacy / no schema). Used to pick rail type. */
  schemaDef: any | null;
  /** Set when this endpoint is a RAIL / return track (not a device field). The
   *  other endpoint must be a device field; the wire becomes a rail export (from an
   *  output field) or rail read (into an input field). */
  railId?: string;
  /** Set when this endpoint is a track/group LAYER param (the arrangement's
   *  mixer strip): the owner track/group id. Wire from a mod OUTPUT on the SAME
   *  track → an own-layer clip wire (dest `__layer__`); from a rail → a
   *  track-level rail read. */
  layerOwner?: string;
  /** Which layer param ('opacity' | 'bypass'); default 'opacity'. */
  layerField?: string;
  /** Set when this endpoint is a scene track's TRIGGER LISTEN (the arrangement
   *  scene grid): the scene track id. Pairs with a rail endpoint — the scenes
   *  launch from that rail's trigger events instead of the global bus. */
  triggerTrack?: string;
  /** With `triggerTrack`: a single scene's listen override (else the whole
   *  track's default). */
  triggerScene?: string;
}

