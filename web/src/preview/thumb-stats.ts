/**
 * Thumbnail sanity metrics — what the bake tool (scripts/bake-thumbs.mjs) and
 * the thumbnail audit e2e flag a preview scenario by. Pure functions over RGBA
 * pixels / plotted samples, so they're unit-testable and run in any page.
 */

export interface ImageStats {
  /** Distinct colours after quantizing each channel to 5 bits. */
  distinct: number;
  /** Mean luma, 0..255. */
  mean: number;
  /** Luma standard deviation, 0..255. */
  std: number;
}

export interface GraphStats {
  /** Finite samples. */
  finite: number;
  /** Sample range as a fraction of the output's declared [min, max]. */
  range: number;
}

export type ThumbFlag = 'blank' | 'same-as-input' | 'flat';

/** Below these a thumbnail is flagged. */
/** Two colours can be a real picture (one lit LED bar on black); one can't. */
export const BLANK_MIN_DISTINCT = 2;
export const BLANK_MIN_STD = 2;
export const SAME_MAX_DIFF = 1.5;
export const FLAT_MAX_RANGE = 0.02;

export function imageStats(rgba: ArrayLike<number>): ImageStats {
  const seen = new Set<number>();
  let sum = 0;
  let sum2 = 0;
  const n = Math.floor(rgba.length / 4);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    sum2 += y * y;
  }
  const mean = n ? sum / n : 0;
  return { distinct: seen.size, mean, std: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0 };
}

/** Mean absolute per-channel (RGB) difference, 0..255. Sizes must match. */
export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return sum / count;
}

/** Samples may be numbers or vectors (a colour output): a vector's
 *  components all count toward the range. */
export function graphStats(values: ReadonlyArray<number | readonly number[]>, min: number, max: number): GraphStats {
  const pts = values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return { finite: pts.length, range: 0 };
  const span = max - min || 1;
  return { finite: pts.length, range: (Math.max(...pts) - Math.min(...pts)) / span };
}

/** The flags a baked thumbnail earns (empty = looks fine). */
export function thumbFlags(t: {
  image?: ImageStats;
  diffFromInput?: number;
  graph?: GraphStats;
}): ThumbFlag[] {
  const flags: ThumbFlag[] = [];
  if (t.image && (t.image.distinct < BLANK_MIN_DISTINCT || t.image.std < BLANK_MIN_STD)) flags.push('blank');
  if (t.diffFromInput !== undefined && t.diffFromInput < SAME_MAX_DIFF) flags.push('same-as-input');
  if (t.graph && (t.graph.finite < 2 || t.graph.range < FLAT_MAX_RANGE)) flags.push('flat');
  return flags;
}
