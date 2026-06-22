/**
 * Known-good real sketches for the Component C engine slice / testbed.
 *
 * These render through the actual executor so the arrangement monitor shows real
 * GPU output:
 *  - `gpuTestSketch` — a solid (0,128,255) anchor scene (deterministic pixel).
 *  - `invertSketch` — a real 2-entry CHAIN (solid blue → color.invert ⇒ orange),
 *    proving the chain path + a switch to non-blue content.
 */

import type { Sketch } from '../../../sketch-types';
import type { ShowSketchOpts } from './arr-engine';

export interface SliceSketch {
  sketch: Sketch;
  opts: ShowSketchOpts;
}

const TESTONLY = 'com.nano.testonly';
const CORE = 'com.nano.core';

/** Solid blue (0,128,255) — deterministic, ideal for a pixel assertion. */
export function gpuTestSketch(traceId = 'arr-monitor'): SliceSketch {
  return {
    sketch: { anchor: 'debug.gpu_test@0', chain: [] },
    opts: { bundle: TESTONLY, effects: ['debug.gpu_test'], traceId },
  };
}

/** A real chain: solid blue (gpu_test) → color.invert ⇒ orange. Proves the
 *  multi-entry chain path and a switch to clearly non-blue content. */
export function invertSketch(traceId = 'arr-monitor'): SliceSketch {
  return {
    sketch: {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'debug.gpu_test', instance_key: 'sk_gen' },
        { type: 'module', module_type: 'color.invert', instance_key: 'sk_inv' },
      ],
      instances: {
        sk_gen: { module_type: 'debug.gpu_test', state: {} },
        sk_inv: { module_type: 'color.invert', state: {} },
      },
    },
    opts: { bundle: TESTONLY, bundles: [CORE], traceId },
  };
}
