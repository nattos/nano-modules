/**
 * ClipSketch → real Structor Sketch mapping (Component C, the live engine slice).
 *
 * A clip hosts a `ClipSketch` (a device list). The engine renders a real
 * Structor `Sketch` (`{anchor, chain}`) through executor.wasm. This module maps
 * one to the other.
 *
 * The current mapping is COARSE — it keys off the clip's *kind* (does it carry a
 * source/generator? is it a frame processor?) and returns a known-good real
 * sketch (`slice-sketches.ts`) so the monitor shows genuine GPU output today.
 * The fake-data device `moduleType`s (`color.saturate`, …) are not yet backed by
 * real effect modules; as they are, this function grows from kind-based to a
 * full chain build (one `ChainEntry` per device). The seam — clip in, renderable
 * `{id, slice}` out — stays the same.
 *
 * `id` is the engine sketch id the clip's content renders under. It is keyed by
 * *content kind* (not clip id): two generator clips share one generator sketch
 * instance and the monitor just re-targets its trace between them. This mirrors
 * the proven testbed pattern (distinct sketch ids per content, switch = trace
 * re-target) and avoids executor instance-id (`@0`) collisions that per-clip
 * sketches sharing one anchor would cause.
 */

import type { Clip } from '../model/composition';
import { clipProcessesTexture, deviceIsSource } from '../model/composition';
import { gpuTestSketch, spinningTrisSketch, type SliceSketch } from './slice-sketches';

export interface ClipRender {
  /** Stable engine sketch id for this content (keyed by kind, see above). */
  id: string;
  slice: SliceSketch;
}

/**
 * Map a clip to a renderable sketch, or `null` when there's nothing to show
 * (an empty clip, or a modulation-only clip that produces no frames).
 */
export function clipToRender(clip: Clip): ClipRender | null {
  // A clip backed by real on-disk media is previewed from its decoded frames
  // (the monitor's video path), not the engine — return null so the engine
  // doesn't render a misleading generator over it.
  if (clip.source?.url) return null;
  // Carries a source/generator → animated generator content (frames advance).
  if (clip.kind === 'video' || clip.sketch.devices.some(deviceIsSource)) {
    return { id: 'arr-sk-gen', slice: spinningTrisSketch() };
  }
  // A frame-processing effect clip → a solid stand-in frame the effects act on.
  if (clip.sketch.devices.length > 0 && clipProcessesTexture(clip)) {
    return { id: 'arr-sk-solid', slice: gpuTestSketch() };
  }
  // Empty or modulation-only: no texture output.
  return null;
}
