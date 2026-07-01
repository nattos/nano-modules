/**
 * The shipping effect bundles — the single source of truth shared by every host:
 * the sketch IDE ("Resolume"), the effect IDE, and the arrangement. Each id is a
 * WASM effect bundle the engine `loadModule()`s so its effects become reachable.
 *
 * `com.nano.testonly` is intentionally EXCLUDED — it holds fixtures for integration
 * tests, not user-facing effects.
 */
export const EFFECT_BUNDLES = [
  'com.nano.core',
  'com.nano.nano',
  'com.nano.lights',
  'com.nano.text', // source.text.plain
  'com.nano.richtext', // source.text.rich (Blitz HTML/CSS)
  'com.nano.legacy', // ports of shipped NanoGraph effects
] as const;

export type EffectBundleId = (typeof EFFECT_BUNDLES)[number];

/** Human-readable label for a bundle id, e.g. for the smart-input's "browse by
 *  bundle" top-level entries. Falls back to the raw id for anything unlisted
 *  (e.g. `com.nano.testonly`, deliberately excluded from `EFFECT_BUNDLES`). */
export const EFFECT_BUNDLE_NAMES: Record<string, string> = {
  'com.nano.core': 'Core',
  'com.nano.nano': 'Nano',
  'com.nano.lights': 'Lights',
  'com.nano.text': 'Text',
  'com.nano.richtext': 'Rich Text',
  'com.nano.legacy': 'Legacy',
  'com.nano.testonly': 'Test Only',
};
