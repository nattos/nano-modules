/**
 * Known-good real sketches for the Component C engine slice.
 *
 * These render through the actual executor (debug effects in the `testonly`
 * bundle), so the arrangement monitor shows real GPU output. Mapping a clip's
 * device list (`ClipSketch`) to a real Structor `Sketch` is later work; the
 * slice proves the render path with deterministic content.
 */

import type { Sketch } from '../../../sketch-types';
import type { ShowSketchOpts } from './arr-engine';

export interface SliceSketch {
  sketch: Sketch;
  opts: ShowSketchOpts;
}

const TESTONLY = 'com.nano.testonly';

/** Solid blue (0,128,255) — deterministic, ideal for a pixel assertion. */
export function gpuTestSketch(traceId = 'arr-monitor'): SliceSketch {
  return {
    sketch: { anchor: 'debug.gpu_test@0', chain: [] },
    opts: { bundle: TESTONLY, effects: ['debug.gpu_test'], traceId },
  };
}

/** Animated colored triangles on a dark background — proves frames advance. */
export function spinningTrisSketch(traceId = 'arr-monitor'): SliceSketch {
  return {
    sketch: { anchor: 'generator.spinningtris@0', chain: [] },
    opts: { bundle: TESTONLY, effects: ['generator.spinningtris'], traceId },
  };
}
