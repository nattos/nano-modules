/**
 * Cache of dynamic GENERATOR-clip thumbnails (#120).
 *
 * Keyed by the clip's tolerance-bucketed param fingerprint (see
 * `engine/generator-fingerprint.ts`), so it stays stable across small edits and two
 * clips with identical generator+params share thumbnails. Each fingerprint holds a
 * sparse map of SAMPLE index → ImageBitmap (samples fill in progressively as the
 * playhead sweeps the clip — live push-capture).
 *
 * Two tiers, mirroring the video thumbnails: a hot in-memory LRU (evicted entries
 * close their bitmaps) over a persistent OPFS disk tier (the same `WorkerThumbStore`
 * the video reel uses, injected via `setGeneratorThumbPersist`). Live captures `put`
 * → memory + disk; `prefetch` warms memory from disk when a clip becomes visible, so
 * strips survive app restarts without re-rendering. Persistence is best-effort and
 * decoupled (unset in tests → memory-only).
 */

/** Injected disk tier (OPFS). Keys are `g<hash>#<sample>`; read returns null on miss. */
export interface GeneratorThumbPersist {
  read(key: string): Promise<ImageBitmap | null>;
  write(key: string, bitmap: ImageBitmap): Promise<void>;
}
let persist: GeneratorThumbPersist | null = null;
export function setGeneratorThumbPersist(p: GeneratorThumbPersist | null): void {
  persist = p;
}

/** cyrb53 — fast low-collision 53-bit hash of the (long JSON) fingerprint → base36. */
function hashFingerprint(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Persistent-store key for a (fingerprint, sample) — `sourceKey#frame` shape. */
const genKey = (fp: string, sample: number): string => `g${hashFingerprint(fp)}#${sample}`;

const MAX_FINGERPRINTS = 64;

class GeneratorThumbCache {
  /** fingerprint → (sample index → bitmap). Insertion order = LRU (oldest first). */
  private map = new Map<string, Map<number, ImageBitmap>>();
  private listeners = new Set<() => void>();
  /** Fingerprints whose disk samples we've already requested (avoid re-prefetching). */
  private prefetched = new Set<string>();
  /** genKeys with a disk read in flight (dedup). */
  private inFlightReads = new Set<string>();

  /** Exact bitmap for (fingerprint, sample), or undefined. Touches LRU. */
  peek(fp: string, sample: number): ImageBitmap | undefined {
    return this.touch(fp)?.get(sample);
  }

  /**
   * Best available bitmap for `sample`, searching the clip's recent fingerprints
   * (`fps[0]` = current, then older ones most-recent-first), with a freshness flag:
   *   - `stale:false` — the EXACT sample under the CURRENT fingerprint (fully up to date);
   *   - `stale:true`  — a fallback: the exact sample (right time) from an older fingerprint,
   *     or the NEAREST captured sample (wrong time) from the most-recent non-empty one.
   * So a cell always shows the latest valid frame it can (across substitution AND param
   * edits) and the caller can shade the stale ones. Undefined only when nothing is cached.
   */
  peekBest(fps: string[], sample: number): { bitmap: ImageBitmap; stale: boolean } | undefined {
    if (!fps.length) return undefined;
    // Fresh: exact sample under the current fingerprint.
    const exactCur = this.touch(fps[0])?.get(sample);
    if (exactCur) return { bitmap: exactCur, stale: false };
    // Stale, RIGHT time: exact sample from the most-recent fingerprint that has it.
    for (const fp of fps) {
      const b = this.touch(fp)?.get(sample);
      if (b) return { bitmap: b, stale: true };
    }
    // Stale, wrong time: nearest captured sample from the most-recent non-empty fingerprint.
    for (const fp of fps) {
      const cells = this.map.get(fp);
      if (cells && cells.size) {
        const b = this.nearestIn(cells, sample);
        if (b) return { bitmap: b, stale: true };
      }
    }
    return undefined;
  }

  /** Look up a fingerprint's cells and bump it to most-recent (LRU touch). */
  private touch(fp: string): Map<number, ImageBitmap> | undefined {
    const cells = this.map.get(fp);
    if (!cells) return undefined;
    this.map.delete(fp);
    this.map.set(fp, cells);
    return cells;
  }

  private nearestIn(cells: Map<number, ImageBitmap>, sample: number): ImageBitmap | undefined {
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

  /** Store a freshly CAPTURED bitmap into memory + persist it to disk (best-effort). */
  put(fp: string, sample: number, bmp: ImageBitmap): void {
    this.insert(fp, sample, bmp);
    void persist?.write(genKey(fp, sample), bmp); // store clones the bitmap; off-main, async
  }

  /** Insert a bitmap into MEMORY ONLY (e.g. one read back from disk — don't re-persist). */
  fill(fp: string, sample: number, bmp: ImageBitmap): void {
    // A live capture may have beaten the disk read in — keep the captured one.
    if (this.map.get(fp)?.has(sample)) { bmp.close(); return; }
    this.insert(fp, sample, bmp);
  }

  private insert(fp: string, sample: number, bmp: ImageBitmap): void {
    let cells = this.map.get(fp);
    if (cells) this.map.delete(fp);
    else cells = new Map();
    cells.get(sample)?.close(); // replace → close the stale bitmap
    cells.set(sample, bmp);
    this.map.set(fp, cells);
    this.evict();
    this.emit();
  }

  /**
   * Warm the memory tier from the disk tier for a clip becoming visible: read any of
   * `samples` not already resident (deduped, once per fingerprint). Lets strips repopulate
   * across app restarts without re-rendering. No-op when persistence isn't wired (tests).
   */
  prefetch(fp: string, samples: number[]): void {
    if (!persist || this.prefetched.has(fp)) return;
    this.prefetched.add(fp);
    if (this.prefetched.size > 256) this.prefetched.clear(); // bounded; allows re-prefetch later
    const p = persist;
    for (const sample of samples) {
      if (this.has(fp, sample)) continue;
      const key = genKey(fp, sample);
      if (this.inFlightReads.has(key)) continue;
      this.inFlightReads.add(key);
      p.read(key)
        .then((bmp) => { if (bmp) this.fill(fp, sample, bmp); })
        .catch(() => { /* OPFS miss/unavailable */ })
        .finally(() => this.inFlightReads.delete(key));
    }
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
    this.prefetched.clear();
    this.inFlightReads.clear();
  }
}

export const generatorThumbCache = new GeneratorThumbCache();
export type { GeneratorThumbCache };
