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
