/**
 * In-memory cache of dynamic GENERATOR-clip thumbnails (#120).
 *
 * Keyed by the clip's tolerance-bucketed param fingerprint (see
 * `engine/generator-fingerprint.ts`), so it stays stable across small edits and two
 * clips with identical generator+params share thumbnails. Each fingerprint holds a
 * sparse map of SAMPLE index → ImageBitmap (samples fill in progressively as the
 * playhead sweeps the clip — live push-capture). LRU over fingerprints; evicted
 * entries close their bitmaps. Session-only (no persistence) — a fingerprint change
 * is cheap to re-capture during playback.
 */

const MAX_FINGERPRINTS = 64;

class GeneratorThumbCache {
  /** fingerprint → (sample index → bitmap). Insertion order = LRU (oldest first). */
  private map = new Map<string, Map<number, ImageBitmap>>();
  private listeners = new Set<() => void>();

  /** Exact bitmap for (fingerprint, sample), or undefined. Touches LRU. */
  peek(fp: string, sample: number): ImageBitmap | undefined {
    const cells = this.map.get(fp);
    if (!cells) return undefined;
    this.map.delete(fp);
    this.map.set(fp, cells);
    return cells.get(sample);
  }

  /**
   * Bitmap for `sample`, or the NEAREST captured sample for this fingerprint when
   * that exact one isn't in yet — so a film-strip cell shows a visually-adjacent
   * frame while it fills, instead of a placeholder (mirrors the video reel's
   * substitution). Returns undefined only when the fingerprint has no samples at all.
   */
  peekNearest(fp: string, sample: number): ImageBitmap | undefined {
    const cells = this.map.get(fp);
    if (!cells || cells.size === 0) return undefined;
    this.map.delete(fp);
    this.map.set(fp, cells);
    const exact = cells.get(sample);
    if (exact) return exact;
    let best: ImageBitmap | undefined;
    let bestD = Infinity;
    for (const [s, b] of cells) {
      const d = Math.abs(s - sample);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  has(fp: string, sample: number): boolean {
    return this.map.get(fp)?.has(sample) ?? false;
  }

  /** Number of distinct samples captured for a fingerprint. */
  count(fp: string): number {
    return this.map.get(fp)?.size ?? 0;
  }

  /** Store a captured bitmap; the cache takes ownership (closes it on evict). */
  put(fp: string, sample: number, bmp: ImageBitmap): void {
    let cells = this.map.get(fp);
    if (cells) this.map.delete(fp);
    else cells = new Map();
    // Replace an existing sample (close the stale bitmap).
    cells.get(sample)?.close();
    cells.set(sample, bmp);
    this.map.set(fp, cells);
    this.evict();
    this.emit();
  }

  private evict(): void {
    while (this.map.size > MAX_FINGERPRINTS) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const cells = this.map.get(oldest)!;
      for (const b of cells.values()) b.close();
      this.map.delete(oldest);
    }
  }

  /** Notified (coalesced by the subscriber) when a new sample lands. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Test/diagnostic: drop everything (closing bitmaps). */
  clear(): void {
    for (const cells of this.map.values()) for (const b of cells.values()) b.close();
    this.map.clear();
  }
}

export const generatorThumbCache = new GeneratorThumbCache();
export type { GeneratorThumbCache };
