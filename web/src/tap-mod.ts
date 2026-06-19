/**
 * Tap value transforms ("tap mods") — the range remapper + write-tap summation.
 *
 * This is one half of a LOCK-STEP pair: the math here MUST stay byte-identical to
 * native/src/sketch/tap_mod.h, because the web executor's job is to reproduce the
 * native pixels exactly, and a tap that feeds a float into a render parameter would
 * desync the image if the two sides shaped the value differently. Any change to a
 * formula here must be mirrored there (and covered by the shared goldens in
 * tap-mod.test.ts).
 *
 * Mods apply to FLOAT rails only. Read taps run `applyTapMod` AFTER reading the rail
 * (before feeding the module); write taps run `applyTapMod` BEFORE writing, then
 * `combineTap` to fold the result into the rail's current value for this frame.
 */

import type { TapCurve, TapCombine, TapMod } from './sketch-types';

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Reflect `x` into [0,1] (period-2 triangle wave) — the "foldback" range handler. */
function fold01(x: number): number {
  const m = ((x % 2) + 2) % 2; // positive modulo into [0,2)
  return m <= 1 ? m : 2 - m;
}

/**
 * Base (ease-in) shaping curve on a normalized value. `power` and `circular` use
 * sign/range-preserving extensions so out-of-range input (no saturation) stays
 * finite and deterministic. `foldback` reflects out-of-range input into [0,1].
 */
function baseCurve(t: number, curve: TapCurve, exponent: number): number {
  switch (curve) {
    case 'quad':
      return t * t;
    case 'circular': {
      const s = 1 - t * t;
      return 1 - Math.sqrt(s > 0 ? s : 0);
    }
    case 'power':
      return t >= 0 ? Math.pow(t, exponent) : -Math.pow(-t, exponent);
    case 'foldback':
      return fold01(t);
    case 'linear':
    default:
      return t;
  }
}

/** Ease-out is the mirror of the ease-in base curve (foldback is symmetric, so unchanged). */
function shapeOut(t: number, curve: TapCurve, exponent: number): number {
  if (curve === 'foldback') return fold01(t);
  return 1 - baseCurve(1 - t, curve, exponent);
}

/**
 * Apply a tap's range remapper to a scalar. Returns `value` unchanged when `mod`
 * is absent or empty. Pipeline: normalize to [0,1] → (saturate|foldback) →
 * curveIn (ease-in) → curveOut (ease-out) → map to [outMin,outMax] → scale.
 * `scale` is applied LAST (in parameter-modulation space, before the downstream
 * magnitude unit-normalization) so it scales the modulation output around its
 * neutral point rather than the raw input.
 */
export function applyTapMod(value: number, mod?: TapMod): number {
  if (!mod) return value;
  let v = value;
  const r = mod.remap;
  if (r) {
    const denom = r.inMax - r.inMin;
    let t = denom !== 0 ? (v - r.inMin) / denom : 0;

    const curveIn = r.curveIn ?? 'linear';
    const curveOut = r.curveOut ?? 'linear';
    const exponent = r.exponent ?? 2;
    const foldback = curveIn === 'foldback' || curveOut === 'foldback';

    if (foldback) t = fold01(t);
    else if (r.saturate) t = clamp01(t);

    t = baseCurve(t, curveIn, exponent);
    t = shapeOut(t, curveOut, exponent);

    v = r.outMin + t * (r.outMax - r.outMin);
  }
  return v * (mod.scale ?? 1);
}

/**
 * Fold a write tap's (already modded) value into the rail's current frame value.
 * The first writer this frame just seeds the rail (`existing === undefined`),
 * regardless of mode; subsequent writers combine per their own `combine` mode.
 */
export function combineTap(
  existing: number | undefined,
  value: number,
  combine?: TapCombine,
  mixFactor?: number,
): number {
  if (existing === undefined) return value;
  switch (combine ?? 'replace') {
    case 'add':
      return existing + value;
    case 'mul':
      return existing * value;
    case 'mix':
      return existing + (value - existing) * (mixFactor ?? 1);
    case 'replace':
    default:
      return value;
  }
}

/**
 * Range-aware fold for a scalar wire's `magnitude` mode (signed/unsigned) — the
 * convenience alternative to `combineTap` that maps a standard-range source value
 * into the DEST field's declared [min,max] per the combine mode, so a modulation
 * source drives a parameter without hand-scaling.
 *
 * `input` is the source value already pre-multiplied by `mod.scale` (the manual
 * `mod.remap` is only used in `absolute` mode, which routes through `combineTap`).
 * `resolved` is the concrete interpretation ('signed' = bipolar −1..1, 'unsigned'
 * = unipolar 0..1; `auto` is resolved by the caller from the source declaration).
 *
 * LOCK-STEP: native twin is native/src/sketch/tap_mod.h applyMagnitude (added
 * when the wire model was ported to the barrel executor) — keep byte-identical,
 * same as `applyTapMod`/`combineTap`.
 */
export function applyMagnitude(
  existing: number,
  input: number,
  resolved: 'signed' | 'unsigned',
  combine: TapCombine | undefined,
  mixFactor: number | undefined,
  min: number,
  max: number,
): number {
  const span = max - min;
  const mid = (min + max) / 2;
  // Where the input lands in [min,max] for a `replace`/`mix` fold.
  const replaceVal = resolved === 'signed'
    ? min + ((input + 1) / 2) * span   // −1→min, 0→mid, 1→max
    : min + input * span;              //  0→min, 1→max
  switch (combine ?? 'replace') {
    case 'add':
      // Identical for both: ±1 input pushes by ±100% of the field span.
      return existing + input * span;
    case 'mul':
      return resolved === 'signed'
        ? mid + (existing - mid) * input   // 1=identity, 0→mid, −1 flips delta
        : min + (existing - min) * input;  // 1=identity, 0→min
    case 'mix':
      return existing + (replaceVal - existing) * (mixFactor ?? 1);
    case 'replace':
    default:
      return replaceVal;
  }
}
