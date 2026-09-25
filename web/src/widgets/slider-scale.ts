/**
 * Slider travel for a field's declared scale (schema `"scale":"log"`, set by
 * state::Schema::logScale()). A log field moves in proportion to the value's
 * logarithm, so every decade gets the same travel — 0.5 Hz is as easy to set
 * as 50 on a 0.01..120 Hz rate. The stored value is still the plain number.
 *
 * LOCK-STEP twin of tap_mod::toScaleTravel / fromScaleTravel
 * (native/src/sketch/tap_mod.h), which fold wires and automation onto a log
 * field in the same travel — so the modulation band a slider draws lines up
 * with where the slider itself would put that value.
 */

export type SliderScale = 'linear' | 'log';

/** A log scale needs a positive range; anything else falls back to linear. */
export function logScaleUsable(min: number, max: number): boolean {
  return min > 0 && max > min && Number.isFinite(max);
}

/** Value → travel (0..1 inside [min,max]; unclamped outside it for linear). */
export function toTravel(v: number, min: number, max: number, scale: SliderScale = 'linear'): number {
  if (scale === 'log' && logScaleUsable(min, max)) {
    return Math.log(Math.max(v, min) / min) / Math.log(max / min);
  }
  const span = max - min;
  return span !== 0 ? (v - min) / span : 0;
}

/** Travel → value. */
export function fromTravel(t: number, min: number, max: number, scale: SliderScale = 'linear'): number {
  if (scale === 'log' && logScaleUsable(min, max)) return min * Math.exp(t * Math.log(max / min));
  return min + t * (max - min);
}

/**
 * Round a dragged value for display/storage. Linear sliders snap to the step's
 * decimals; a log slider keeps three significant figures instead, since a
 * fixed step is far too coarse at the bottom of the range and far too fine at
 * the top.
 */
export function roundForScale(v: number, step: number, scale: SliderScale = 'linear'): number {
  if (scale === 'log') {
    if (v === 0 || !Number.isFinite(v)) return v;
    const mag = Math.pow(10, 2 - Math.floor(Math.log10(Math.abs(v))));
    return Math.round(v * mag) / mag;
  }
  const precision = step.toString().split('.')[1]?.length || 0;
  const factor = Math.pow(10, precision);
  return Math.round(v * factor) / factor;
}
