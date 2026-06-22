/**
 * ThumbnailCache — a generic LRU + in-flight-dedup + async-fill cache, keyed by
 * `(sourceKey, frame)`. Decoupled from decoding: callers inject a
 * `ThumbnailProducer`, so the cache logic is pure and unit-testable headlessly
 * (the real producer that drives the video playback service is in
 * `video-thumbnail-producer.ts`).
 *
 * Usage from a clip renderer:
 *   const v = cache.get(sourceKey, frame);   // null on miss (the fill is scheduled)
 *   cache.onFill = (sk, f) => redraw();       // redraw when the real thumb lands
 *
 * `get()` is synchronous and side-effecting on a miss (it schedules the fill and
 * returns null), so a draw loop never awaits; placeholders show until thumbs
 * arrive — matching the mockup's "procedural until decoded" behavior.
 */

export type ThumbKey = string;

export function thumbKey(sourceKey: string, frame: number): ThumbKey {
  return `${sourceKey}#${frame}`;
}

export interface ThumbnailProducer<V> {
  /** Decode + downscale one frame. May honor `signal` to abort superseded work. */
  produce(sourceKey: string, frame: number, signal?: AbortSignal): Promise<V>;
}

export interface ThumbnailCacheOpts<V> {
  /** Max resident entries; least-recently-used are evicted past this. */
  capacity?: number;
  /** Called when an entry is evicted/cleared (e.g. `(bmp) => bmp.close()`). */
  dispose?: (value: V) => void;
}

interface Inflight<V> {
  promise: Promise<V>;
  controller: AbortController;
}

export class ThumbnailCache<V> {
  private cache = new Map<ThumbKey, V>(); // insertion order == LRU recency
  private inflight = new Map<ThumbKey, Inflight<V>>();
  private capacity: number;
  private dispose?: (value: V) => void;

  private _hits = 0;
  private _misses = 0;

  /** Fired when an async fill completes; redraw in response. */
  onFill: ((sourceKey: string, frame: number, value: V) => void) | null = null;

  constructor(
    private producer: ThumbnailProducer<V>,
    opts: ThumbnailCacheOpts<V> = {},
  ) {
    this.capacity = Math.max(1, opts.capacity ?? 256);
    this.dispose = opts.dispose;
  }

  /**
   * Synchronous lookup. On hit: marks the entry most-recently-used and returns
   * it. On miss: schedules an async fill (deduped) and returns null.
   */
  get(sourceKey: string, frame: number): V | null {
    const key = thumbKey(sourceKey, frame);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // Touch: move to most-recently-used end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      this._hits++;
      return hit;
    }
    this._misses++;
    void this.request(sourceKey, frame);
    return null;
  }

  /** Returns true if a decoded thumbnail is resident (no scheduling side effect). */
  has(sourceKey: string, frame: number): boolean {
    return this.cache.has(thumbKey(sourceKey, frame));
  }

  /**
   * Ensure a thumbnail exists, returning it. Deduplicates concurrent requests
   * for the same key; resolves from cache instantly on a hit.
   */
  request(sourceKey: string, frame: number): Promise<V> {
    const key = thumbKey(sourceKey, frame);
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const existing = this.inflight.get(key);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = this.producer
      .produce(sourceKey, frame, controller.signal)
      .then((value) => {
        this.inflight.delete(key);
        // A clear()/abort may have superseded this fill; honor it.
        if (controller.signal.aborted) {
          this.dispose?.(value);
          return value;
        }
        this.insert(key, value);
        this.onFill?.(sourceKey, frame, value);
        return value;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, { promise, controller });
    return promise;
  }

  private insert(key: ThumbKey, value: V) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    // Evict LRU (front of the Map) past capacity.
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as ThumbKey | undefined;
      if (oldest === undefined) break;
      const v = this.cache.get(oldest)!;
      this.cache.delete(oldest);
      this.dispose?.(v);
    }
  }

  /** Abort in-flight work and drop all cached entries (disposing each). */
  clear() {
    for (const { controller } of this.inflight.values()) controller.abort();
    this.inflight.clear();
    if (this.dispose) for (const v of this.cache.values()) this.dispose(v);
    this.cache.clear();
  }

  stats() {
    return {
      size: this.cache.size,
      inflight: this.inflight.size,
      hits: this._hits,
      misses: this._misses,
      capacity: this.capacity,
    };
  }
}
