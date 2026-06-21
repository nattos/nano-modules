/**
 * Shared GPU usage / headroom math for the status readouts.
 *
 * `engine.gpuTimeMs` is an estimated GPU busy-time (a CPU-fence proxy today —
 * see engine-worker's `gpuTimeEma`). Compared against the target-frame budget
 * (`1000 / targetFps`) it yields a usage fraction and the headroom that's left.
 * Both the IDE monitor and the Resolume tab bar render this; the markup/styling
 * lives in each component, only the computation is shared.
 */

import { html, TemplateResult } from 'lit';

/** Target framerates offered by the headroom selector. */
export const TARGET_FPS_OPTIONS = [30, 60, 120];

/**
 * A fixed-width, right-aligned numeric cell. The status readouts use tabular
 * figures so each digit is the same width, but the *digit count* still changes
 * ("9.5"→"10.5" ms, "100%"→"5%" free), which would otherwise reflow every
 * sibling metric in the flex row. Reserving a min-width sized for the widest
 * expected value keeps the whole readout stationary within its normal range
 * (it only grows past `ch` for out-of-range alarm values, where a shift is ok).
 *
 * Self-contained inline styling so both shadow-DOM hosts can share it without
 * each needing a matching CSS rule.
 */
export function fixedNum(value: string | number, ch: number): TemplateResult {
  return html`<span
    style="display:inline-block;text-align:right;min-width:${ch}ch;font-variant-numeric:tabular-nums"
    >${value}</span
  >`;
}

export interface HeadroomInfo {
  /** False until the first live GPU sample (or while paused / barrel mode) —
   *  the readout shows a placeholder instead of a misleading 100% free. */
  measured: boolean;
  /** Estimated GPU ms this frame. */
  gpuMs: number;
  /** Target-frame budget in ms (`1000 / targetFps`). */
  budgetMs: number;
  /** Whole-percent headroom remaining (clamped to >= 0). */
  headroomPct: number;
  /** Colour level: comfortable / tight / over budget. */
  level: 'ok' | 'tight' | 'over';
}

export function computeHeadroom(gpuMs: number, targetFps: number): HeadroomInfo {
  const budgetMs = 1000 / targetFps;
  if (gpuMs <= 0) {
    return { measured: false, gpuMs: 0, budgetMs, headroomPct: 100, level: 'ok' };
  }
  const usage = gpuMs / budgetMs;
  const headroomPct = Math.max(0, Math.round((1 - usage) * 100));
  const level = usage >= 1 ? 'over' : usage >= 0.8 ? 'tight' : 'ok';
  return { measured: true, gpuMs, budgetMs, headroomPct, level };
}
