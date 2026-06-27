/**
 * Shared horizontal-transform helpers so the ruler and the lane grid stay in
 * lock-step (same warp curve, zoom, scroll, and left header offset).
 */

import { store } from '../state/store';
import { BeatGrid, WarpCurve } from '../model/beat-grid';
import {
  derivedWarpSegments,
  compositionLengthBeats,
} from '../model/composition';

/** Base (resizable) width of the left track-header column content (px). The
 *  effective column also grows by the group gutter — see `store.headerWidth`. */
export const HEADER_WIDTH = 184;

/** Lane row height and automation lane height (px). */
export const ROW_HEIGHT = 56;
export const AUTO_LANE_HEIGHT = 48;
export const RULER_HEIGHT = 30;

/**
 * Build the current BeatGrid (warp curve + zoom + scroll). Rebuilt per call;
 * cheap for mockup-sized compositions. Extends the curve well past content so
 * scrolling/zoom-out never runs off the table.
 */
export function buildBeatGrid(): BeatGrid {
  const segments = derivedWarpSegments(store.composition);
  const total = compositionLengthBeats(store.composition) + 32;
  const curve = new WarpCurve(segments, total);
  return new BeatGrid(curve, store.pxPerBeat, store.scrollUnits);
}
