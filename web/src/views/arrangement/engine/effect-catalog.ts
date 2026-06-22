/**
 * Effect catalog — the curated set of REAL effects a clip's device chain can host
 * (Component F: real clip chains).
 *
 * Each entry is a real effect that exists in a shipped bundle, with its float
 * `PrimaryInput` fields (key + range + default) transcribed from the effect's C++
 * schema. This catalog is the single source of truth for:
 *   - building a real Structor `Sketch` from a clip (`clip-sketch.ts`),
 *   - seeding a device's default param state (`store.makeDevice`),
 *   - rendering the inspector's real param sliders (Component F task 41).
 *
 * `role`: a `generator` device becomes the FIRST chain entry (a source that
 * produces pixels with no input); `effect` devices follow and the executor chains
 * them top-to-bottom — each reads the previous entry's output implicitly, no
 * wires. A clip with effect devices but no generator gets an implicit solid
 * stand-in as the first entry so the effects have a real input to process.
 *
 * Ids are the effect ids the bundles register (each effect's C++ `registerEffect`
 * id — `color.*` / `filter.*` — verified against the engine's discovered list).
 * Keep field ranges/defaults in sync with the C++ `.floatField(...)` declarations
 * (e.g. native/wasm_modules/hsl/main.cpp). When runtime schema discovery is wired
 * into the arrangement this catalog can be derived instead of hand-kept.
 */

export interface EffectField {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

export interface CatalogEffect {
  type: string;
  name: string;
  /** Bundle module id to loadModule() before use. */
  bundle: string;
  role: 'generator' | 'effect';
  fields: EffectField[];
}

const CORE = 'com.nano.core';
const TESTONLY = 'com.nano.testonly';

const fld = (key: string, label: string, min: number, max: number, def: number): EffectField =>
  ({ key, label, min, max, default: def });

export const EFFECT_CATALOG: CatalogEffect[] = [
  // ── Generators (first chain entry) ──────────────────────────────────────
  {
    type: 'source.solid_color',
    name: 'Solid Color',
    bundle: CORE,
    role: 'generator',
    fields: [],
  },
  {
    // The effect registers as `debug.spinningtris` (testonly bundle), NOT
    // `generator.spinningtris` — see native/wasm_modules/spinningtris/main.cpp.
    type: 'debug.spinningtris',
    name: 'Spinning Triangles',
    bundle: TESTONLY,
    role: 'generator',
    fields: [
      fld('triangles', 'Triangles', 0, 1, 0.1),
      fld('speed', 'Speed', 0, 1, 0.5),
    ],
  },
  // ── Effects (chain) ─────────────────────────────────────────────────────
  {
    type: 'color.hsl',
    name: 'HSL',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('hue_shift', 'Hue', -1, 1, 0),
      fld('saturation', 'Saturation', -1, 1, 0),
      fld('lightness', 'Lightness', -1, 1, 0),
    ],
  },
  {
    type: 'color.tone.brightness_contrast',
    name: 'Brightness / Contrast',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('brightness', 'Brightness', -1, 1, 0),
      fld('contrast', 'Contrast', -1, 1, 0),
    ],
  },
  {
    type: 'color.saturate',
    name: 'Saturate',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('prescale', 'Prescale', 0, 4, 1),
      fld('asymm', 'Asymmetry', -1, 1, 0),
      fld('linear_deadzone', 'Deadzone', 0, 1, 0),
    ],
  },
  {
    type: 'filter.vignette',
    name: 'Vignette',
    bundle: CORE,
    role: 'effect',
    fields: [
      fld('amount', 'Amount', -1, 1, -0.5),
      fld('radius', 'Radius', 0, 1, 0.6),
      fld('softness', 'Softness', 0, 1, 0.4),
    ],
  },
  {
    type: 'color.invert',
    name: 'Invert',
    bundle: CORE,
    role: 'effect',
    fields: [],
  },
];

const BY_TYPE = new Map(EFFECT_CATALOG.map((e) => [e.type, e]));

/** Solid stand-in used as the first chain entry when a chain has no generator. */
export const IMPLICIT_ANCHOR = { type: 'debug.gpu_test', bundle: TESTONLY };

export function catalogEffect(type: string): CatalogEffect | undefined {
  return BY_TYPE.get(type);
}

export function isCatalogEffect(type: string): boolean {
  return BY_TYPE.has(type);
}

/** Default field state for an effect (field key → default value). */
export function defaultStateFor(type: string): Record<string, number> {
  const e = BY_TYPE.get(type);
  const state: Record<string, number> = {};
  if (e) for (const f of e.fields) state[f.key] = f.default;
  return state;
}

export const GENERATORS = EFFECT_CATALOG.filter((e) => e.role === 'generator');
export const EFFECTS = EFFECT_CATALOG.filter((e) => e.role === 'effect');
