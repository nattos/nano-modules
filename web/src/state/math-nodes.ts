/**
 * VARIABLE-ARITY nodes as the EDITOR sees them: the split-out modulation math
 * nodes (`mod.shaper.add`, `.multiply`, …) and `mod.shaper.switch`.
 *
 * They declare a fixed bank of 8 inputs plus an `input_count` field saying how
 * many actually participate, because a schema is published once per module type
 * and so arity can only ever be a value, not a shape (see
 * native/wasm_modules/mod_math/main.cpp and mod_switch/main.cpp). Everything
 * here is the UI half of that arrangement: which ids carry a count, and the
 * synchronous rule that turns a stored count into the set of fields to hide.
 * The two families differ only in their field prefix (`input_` vs `case_`).
 *
 * The rule is synchronous and reads the DOCUMENT, so a card shows the right
 * number of inputs on its very first render — no engine round trip, no reflow
 * when a later answer arrives.
 */

import { registerVisibilityRule } from './field-visibility';

/** Mirrors `kMaxInputs` in native/wasm_modules/mod_math/main.cpp. */
export const MATH_MAX_INPUTS = 8;
/** Mirrors the `input_count` field's declared minimum. */
export const MATH_MIN_INPUTS = 2;

/**
 * Every module type built from mod_math/main.cpp. Mirrors the `registerEffect`
 * block in native/wasm_modules/core/main.cpp — adding an op there means adding
 * its id here, or its card renders all 8 inputs with no count control.
 */
export const MATH_MODULE_TYPES: readonly string[] = [
  'mod.shaper.add',
  'mod.shaper.subtract',
  'mod.shaper.multiply',
  'mod.shaper.divide',
  'mod.shaper.min',
  'mod.shaper.max',
  'mod.shaper.average',
  'mod.shaper.difference',
  'mod.shaper.screen',
  'mod.shaper.power',
  'mod.shaper.modulo',
  'mod.shaper.greater',
  'mod.shaper.less',
  'mod.shaper.hypot',
  'mod.shaper.quantize',
];

const MATH_TYPE_SET = new Set(MATH_MODULE_TYPES);

/** True for a module type that carries an adjustable input count. */
export function isMathModuleType(moduleType: string): boolean {
  return MATH_TYPE_SET.has(moduleType);
}

/** The field name for the Nth input, 1-based — `input_1` … `input_8`. */
export function mathInputField(n: number): string {
  return `input_${n}`;
}

/**
 * The active input count from an instance's state, clamped to what the schema
 * allows. Absent (an older sketch, or a card that has never been touched) reads
 * as the minimum, which is the schema default.
 */
export function mathInputCount(state: Record<string, any> | undefined): number {
  const raw = state?.input_count;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : MATH_MIN_INPUTS;
  return Math.min(MATH_MAX_INPUTS, Math.max(MATH_MIN_INPUTS, n));
}

/**
 * Fields a math node hides for a given state: every input past the count, plus
 * `input_count` itself — it changes the card's SHAPE rather than a value, so it
 * lives under the gear icon with blend and crossfade instead of sitting among
 * the ordinary parameter rows.
 */
export function mathHiddenFields(state: Record<string, any> | undefined): string[] {
  const count = mathInputCount(state);
  const hidden = ['input_count'];
  for (let n = count + 1; n <= MATH_MAX_INPUTS; n++) hidden.push(mathInputField(n));
  return hidden;
}

for (const moduleType of MATH_MODULE_TYPES) {
  registerVisibilityRule(moduleType, mathHiddenFields);
}

// ──────────────────────────────────────────────────────────────────────────
// mod.shaper.switch — the same arity arrangement, different field prefix.
//
// It is not a math node (its cases are polymorphic `any` ports, not floats), but
// the SHAPE problem is identical: a fixed bank of 8 plus a count value, because
// arity can no more be a schema shape than type can. Sharing the mechanism here
// keeps one answer to "how does a card change its own field set".
// ──────────────────────────────────────────────────────────────────────────

export const SWITCH_MODULE_TYPE = 'mod.shaper.switch';

/** Mirrors `kMaxCases` / the `input_count` minimum in mod_switch/main.cpp. */
export const SWITCH_MAX_CASES = 8;
export const SWITCH_MIN_CASES = 2;

/** The field name for the Nth case, 1-based — `case_1` … `case_8`. */
export function switchCaseField(n: number): string {
  return `case_${n}`;
}

/** The active case count from an instance's state, clamped to the schema range. */
export function switchCaseCount(state: Record<string, any> | undefined): number {
  const raw = state?.input_count;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : SWITCH_MIN_CASES;
  return Math.min(SWITCH_MAX_CASES, Math.max(SWITCH_MIN_CASES, n));
}

/** Cases past the count, plus `input_count` itself (a gear-panel control). */
export function switchHiddenFields(state: Record<string, any> | undefined): string[] {
  const count = switchCaseCount(state);
  const hidden = ['input_count'];
  for (let n = count + 1; n <= SWITCH_MAX_CASES; n++) hidden.push(switchCaseField(n));
  return hidden;
}

registerVisibilityRule(SWITCH_MODULE_TYPE, switchHiddenFields);
