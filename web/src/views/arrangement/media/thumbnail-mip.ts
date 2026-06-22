/**
 * Thumbnail mip-in-time: granularity levels over frame indices.
 *
 * A "level" is a temporal mip level. Level 0 is finest; each step doubles the
 * stride: `stride(L) = baseStride · 2^L`. A tile at level L represents the
 * source frame `snap(frame, L)` (nearest multiple of the stride). Because coarse
 * strides are multiples of fine strides, tiles whose frames coincide are the
 * same image and share one cache/store entry — so levels cost storage only for
 * the *extra* frames they introduce, exactly like mip sharing.
 *
 * Readers pick a level from zoom (frames-per-thumbnail) and request a frame
 * range at that level; the cache prefetches the strided frames covering it.
 */

export interface MipConfig {
  /** Frames per tile at level 0 (the finest granularity). */
  baseStride: number;
}

export const DEFAULT_MIP: MipConfig = { baseStride: 1 };

export function strideForLevel(level: number, cfg: MipConfig = DEFAULT_MIP): number {
  return cfg.baseStride * 2 ** Math.max(0, Math.floor(level));
}

/** Snap a frame to the nearest tile boundary at `level` (clamped to ≥ 0). */
export function snapFrame(frame: number, level: number, cfg: MipConfig = DEFAULT_MIP): number {
  const s = strideForLevel(level, cfg);
  return Math.max(0, Math.round(frame / s) * s);
}

/**
 * Choose the coarsest level whose tile stride is ≤ `framesPerThumb`, so tiles
 * are dense enough to fill the strip without redundant decoding. Readers derive
 * `framesPerThumb = thumbWidthPx / pxPerFrame`.
 */
export function levelForFramesPerThumb(
  framesPerThumb: number,
  cfg: MipConfig = DEFAULT_MIP,
): number {
  if (framesPerThumb <= cfg.baseStride) return 0;
  return Math.max(0, Math.floor(Math.log2(framesPerThumb / cfg.baseStride)));
}

/** The strided frames covering [startFrame, endFrame] inclusive at `level`. */
export function framesInRange(
  startFrame: number,
  endFrame: number,
  level: number,
  cfg: MipConfig = DEFAULT_MIP,
): number[] {
  const s = strideForLevel(level, cfg);
  const first = Math.max(0, Math.floor(Math.max(0, startFrame) / s) * s);
  const out: number[] = [];
  for (let f = first; f <= endFrame; f += s) out.push(f);
  return out;
}
