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

/** Cached warp curve — rebuilt only when the document changes (`store.warpEpoch`),
 *  NOT on every scroll/zoom/playhead frame. buildBeatGrid is called per editor per
 *  rAF frame; recomputing `derivedWarpSegments` (reads every clip → heavy MobX get
 *  traffic) each time was the dominant scroll-jank cost (per a CPU trace). */
let _warpCache: { epoch: number; curve: WarpCurve } | null = null;

/**
 * Build the current BeatGrid (warp curve + zoom + scroll). The warp CURVE is
 * memoized on `store.warpEpoch` (bumped on every edit/undo/redo/load); only the
 * cheap zoom/scroll-dependent BeatGrid is built per call. Extends the curve well
 * past content so scrolling/zoom-out never runs off the table.
 */
export function buildBeatGrid(): BeatGrid {
  const epoch = store.warpEpoch;
  if (!_warpCache || _warpCache.epoch !== epoch) {
    const segments = derivedWarpSegments(store.composition);
    const total = compositionLengthBeats(store.composition) + 32;
    _warpCache = { epoch, curve: new WarpCurve(segments, total) };
  }
  return new BeatGrid(_warpCache.curve, store.pxPerBeat, store.scrollUnits);
}
