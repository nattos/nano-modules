/**
 * ThumbnailManager — the zoom-aware, persistent, tiered thumbnail cache.
 *
 * Tiers (miss falls through): memory (hot, live bitmaps) → persistent store
 * (warm, serialized) → decoder (cold). A tile decoded once is persisted, so
 * slow-seek/cloud sources pay decode cost once and app restarts read from the
 * store instead of re-decoding.
 *
 * Write side — VIEWS: readers declare interest with `setView(id, view)`:
 *   { sourceKey, level, startFrame, endFrame, pattern }
 * `pattern:'loop'` PINS the whole region at that granularity (kept resident);
 * `pattern:'window'` prefetches the visible range + read-ahead (evictable). The
 * manager unions all views, sizes + pins memory, and prefetches the right mip
 * level (memory ← store ← decode). Callers should rate-limit LEVEL changes.
 *
 * Read side — PEEK: `peek(sourceKey, frame, level)` is synchronous and never
 * schedules work. It returns the exact tile, or the nearest cached substitute
 * from ANY level, tagged with the frame it represents and whether it's exact —
 * the "stretching" primitive. While a new level prefetches, readers draw the
 * substitute at its true frame and size it to the neighbor gap (gaps when
 * sparser, overlap when denser).
 */

import {
  ThumbnailCache,
  thumbKey,
  type ThumbnailProducer,
  type ThumbKey,
} from './thumbnail-cache';
import {
  snapFrame,
  framesInRange,
  type MipConfig,
  DEFAULT_MIP,
} from './thumbnail-mip';
import {
  type PersistentThumbStore,
  type ThumbCodec,
} from './thumbnail-store';

export type AccessPattern = 'window' | 'loop';

export interface ThumbView {
  sourceKey: string;
  /** Granularity (mip level) the reader wants resident. */
  level: number;
  startFrame: number;
  endFrame: number;
  /** 'loop' pins the whole region; 'window' prefetches range + read-ahead. */
  pattern: AccessPattern;
  /** Extra frames to prefetch beyond each edge of a 'window' (defaults to a stride). */
  readaheadFrames?: number;
}

export interface ThumbHit<V> {
  value: V;
  /** Source frame the served tile represents (position the substitute here). */
  frame: number;
  /** True when the served tile is the exact requested (level, frame). */
  exact: boolean;
  /** |served frame − requested frame| (0 when exact); how far it's stretched. */
  distanceFrames: number;
}

export interface ThumbnailManagerOpts<V> {
  /** Baseline memory budget; grows to fit the pinned + window working set. */
  baseCapacity?: number;
  mip?: MipConfig;
  /** Dispose a memory-tier value on eviction (e.g. `(b) => b.close()`). */
  dispose?: (value: V) => void;
}

export class ThumbnailManager<V, S = V> {
  private mem: ThumbnailCache<V>;
  private mip: MipConfig;
  private baseCapacity: number;
  private views = new Map<string, ThumbView>();
  /** Per-source sorted list of in-memory frames, for nearest-substitute peek. */
  private index = new Map<string, number[]>();

  private _decodes = 0;

  /** Fired when a tile lands in memory; readers redraw (coalesce with rAF). */
  onChange: ((sourceKey: string, frame: number) => void) | null = null;

  constructor(
    private decoder: ThumbnailProducer<V>,
    private store: PersistentThumbStore<S>,
    private codec: ThumbCodec<V, S>,
    opts: ThumbnailManagerOpts<V> = {},
  ) {
    this.mip = opts.mip ?? DEFAULT_MIP;
    this.baseCapacity = Math.max(16, opts.baseCapacity ?? 256);

    // Memory tier: its producer is the tiered (store → decode → persist) fill.
    this.mem = new ThumbnailCache<V>(this.tieredProducer(), {
      capacity: this.baseCapacity,
      dispose: opts.dispose,
    });
    this.mem.onFill = (sk, f) => {
      this.indexAdd(sk, f);
      this.onChange?.(sk, f);
    };
    this.mem.onEvict = (sk, f) => this.indexRemove(sk, f);
  }

  /** store(key) → decode(+persist). The memory cache fills through this. */
  private tieredProducer(): ThumbnailProducer<V> {
    return {
      produce: async (sourceKey, frame, signal) => {
        const key = thumbKey(sourceKey, frame);
        const serialized = await this.store.read(key);
        if (serialized != null) return this.codec.decode(serialized);
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        this._decodes++;
        const value = await this.decoder.produce(sourceKey, frame, signal);
        // Persist (encode) without blocking the returned value.
        void this.codec.encode(value).then((enc) => this.store.write(key, enc)).catch(() => {});
        return value;
      },
    };
  }

  // ── Read side ─────────────────────────────────────────────────────────

  /**
   * Best-available tile for (frame, level), synchronous + non-scheduling.
   * Returns the exact tile, else the nearest cached substitute (any level), or
   * null. `maxDistanceFrames` caps how far a substitute may be (default: none).
   */
  peek(
    sourceKey: string,
    frame: number,
    level: number,
    maxDistanceFrames = Infinity,
  ): ThumbHit<V> | null {
    const snapped = snapFrame(frame, level, this.mip);
    const exact = this.mem.peek(sourceKey, snapped);
    if (exact !== null) return { value: exact, frame: snapped, exact: true, distanceFrames: 0 };

    const near = this.nearest(sourceKey, frame);
    if (near === null) return null;
    const dist = Math.abs(near - frame);
    if (dist > maxDistanceFrames) return null;
    const v = this.mem.peek(sourceKey, near);
    if (v === null) return null; // index drift guard
    return { value: v, frame: near, exact: false, distanceFrames: dist };
  }

  /** True if the exact (frame, level) tile is resident in memory. */
  has(sourceKey: string, frame: number, level: number): boolean {
    return this.mem.has(sourceKey, snapFrame(frame, level, this.mip));
  }

  /** Await a single tile (memory → store → decode). */
  ensure(sourceKey: string, frame: number, level: number): Promise<V> {
    return this.mem.request(sourceKey, snapFrame(frame, level, this.mip));
  }

  // ── Write side (views) ──────────────────────────────────────────────────

  /** Register/replace a reader's view (pass null to drop it), then reconcile. */
  setView(viewId: string, view: ThumbView | null) {
    if (view) this.views.set(viewId, view);
    else this.views.delete(viewId);
    this.reconcile();
  }

  /** Recompute the working set: size + pin memory, then prefetch needed tiles. */
  private reconcile() {
    const pinned = new Set<ThumbKey>();
    // Ordered prefetch list: loop tiles first, then window tiles by proximity.
    const order: Array<{ sourceKey: string; frame: number }> = [];
    const seen = new Set<ThumbKey>();

    const add = (sourceKey: string, frame: number, pin: boolean) => {
      const key = thumbKey(sourceKey, frame);
      if (pin) pinned.add(key);
      if (seen.has(key)) return;
      seen.add(key);
      order.push({ sourceKey, frame });
    };

    for (const v of this.views.values()) {
      if (v.pattern !== 'loop') continue;
      for (const f of framesInRange(v.startFrame, v.endFrame, v.level, this.mip)) {
        add(v.sourceKey, f, true);
      }
    }
    for (const v of this.views.values()) {
      if (v.pattern !== 'window') continue;
      const ra = v.readaheadFrames ?? 0;
      const frames = framesInRange(v.startFrame - ra, v.endFrame + ra, v.level, this.mip);
      const center = (v.startFrame + v.endFrame) / 2;
      frames.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      for (const f of frames) add(v.sourceKey, f, false);
    }

    // Size memory to hold the whole working set (+ headroom for substitutes).
    this.mem.setCapacity(Math.max(this.baseCapacity, seen.size + (seen.size >> 2)));
    this.mem.setPinned(pinned);

    // Prefetch (deduped by the memory cache); fire-and-forget.
    for (const { sourceKey, frame } of order) {
      void this.mem.request(sourceKey, frame).catch(() => {});
    }
  }

  // ── Lifecycle / introspection ───────────────────────────────────────────

  /** Drop the hot tier (keep the store) — models a cold app restart. */
  clearMemory() {
    this.mem.clear();
    this.index.clear();
  }

  stats() {
    return {
      memory: this.mem.stats(),
      store: this.store.size(),
      decodes: this._decodes,
      views: this.views.size,
    };
  }

  // ── Per-source frame index (nearest substitute) ─────────────────────────

  private indexAdd(sourceKey: string, frame: number) {
    let arr = this.index.get(sourceKey);
    if (!arr) { arr = []; this.index.set(sourceKey, arr); }
    const i = lowerBound(arr, frame);
    if (arr[i] !== frame) arr.splice(i, 0, frame);
  }

  private indexRemove(sourceKey: string, frame: number) {
    const arr = this.index.get(sourceKey);
    if (!arr) return;
    const i = lowerBound(arr, frame);
    if (arr[i] === frame) arr.splice(i, 1);
  }

  private nearest(sourceKey: string, frame: number): number | null {
    const arr = this.index.get(sourceKey);
    if (!arr || arr.length === 0) return null;
    const i = lowerBound(arr, frame);
    if (i === 0) return arr[0];
    if (i >= arr.length) return arr[arr.length - 1];
    const lo = arr[i - 1];
    const hi = arr[i];
    return frame - lo <= hi - frame ? lo : hi;
  }
}

/** First index in sorted `arr` whose value is ≥ `x` (binary search). */
function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
