/**
 * FrameCache — per-clip GPU-texture cache for the playback service.
 *
 * Two sets: a **pinned** set (frames the access mode says we should hold
 * indefinitely — loop range, hot frames) and an **LRU** set (recently-
 * presented frames). Together they share a byte budget; eviction is
 * LRU-first, with pinned-oldest as a last resort if pinned alone
 * exceeds the budget.
 *
 * GPU work is delegated to a minimal GPUHost-shaped interface so the
 * cache is unit-testable without a real WebGPU device.
 */

/** Just the bits of `GPUHost` the cache touches — keep the surface
 *  small so vitest can mock it without dragging in WebGPU types. */
export interface GpuHostLike {
  createTexture(width: number, height: number, formatCode: number): number;
  release(handle: number): void;
}

/** Bytes per pixel for the texture formats the cache allocates. Matches
 *  the codes accepted by GPUHost.createTexture (gpu-host.ts). */
const FORMAT_BPP: Record<number, number> = {
  0: 4,    // BGRA8
  1: 4,    // RGBA8
  2: 4,    // Surface (rgba8unorm/bgra8unorm — assume 4)
  3: 8,    // RGBA16F
  4: 4,    // R32F
  5: 16,   // RGBA32F
};

interface Entry {
  frameIdx: number;
  textureHandle: number;
  sizeBytes: number;
  lastAccessedMs: number;
  /** False between `reserve()` and the decode writing real pixels into
   *  the texture. A not-ready entry must never be served as a cache hit
   *  (it's still black) nor evicted (its decode is writing into it). */
  ready: boolean;
}

export interface FrameCacheStats {
  /** Total bytes resident across both sets. */
  bytes: number;
  /** Distinct frames cached. */
  entries: number;
  /** Cumulative hits / misses since the last resetStats(). */
  hits: number;
  misses: number;
  /** Cumulative hits / (hits + misses); 0 when both are 0. */
  hitRate: number;
  /** Hits / misses observed in the last `recentWindowMs` of wall-clock
   *  time. The live, "how are we doing right now" view. */
  recentHits: number;
  recentMisses: number;
  recentHitRate: number;
  /** True if a pinned entry was evicted to honor the budget. Sticky
   *  until `resetStats()`; the playback service surfaces this to
   *  downgrade caching aggressiveness for one cycle. */
  pinnedEvicted: boolean;
}

/** One sink-request outcome, timestamped for the rolling window. */
interface CacheEvent { t: number; hit: boolean; }

export class FrameCache {
  private gpuHost: GpuHostLike;
  private budgetBytes: number;

  // frameIdx → Entry. We keep one Map for both pinned and LRU; pinned
  // membership is tracked separately so we can iterate LRU-only for
  // eviction without scanning everything.
  private entries = new Map<number, Entry>();
  private pinned = new Set<number>();

  private bytesUsed = 0;
  private hits = 0;
  private misses = 0;
  private pinnedEvicted = false;
  private accessTicker = 0;          // monotonic counter for ordering

  // Rolling-window stats. Each lookup() appends a timestamped event;
  // stats() prunes everything older than `recentWindowMs` and counts
  // what's left. Clock is injectable so unit tests stay deterministic.
  private events: CacheEvent[] = [];
  private now: () => number;
  private recentWindowMs: number;

  constructor(
    gpuHost: GpuHostLike,
    budgetBytes: number = 256 * 1024 * 1024,
    opts?: { now?: () => number; recentWindowMs?: number },
  ) {
    this.gpuHost = gpuHost;
    this.budgetBytes = budgetBytes;
    this.now = opts?.now ?? defaultNow;
    this.recentWindowMs = opts?.recentWindowMs ?? 1000;
  }

  /** Returns the existing handle for `frameIdx` if cached, else -1.
   *  Counts as a sink request — records a hit/miss (cumulative + window)
   *  and bumps the LRU position. Internal callers that only want to peek
   *  (prefetch scheduling) must use `has()` instead so they don't
   *  pollute the stats. */
  lookup(frameIdx: number): number {
    const e = this.entries.get(frameIdx);
    // A reserved-but-not-yet-decoded entry is still black — treat it as a
    // miss so the caller awaits the in-flight decode rather than serving
    // garbage. (With slow <video> seeks the decode chain can back up, so
    // this window is real, not theoretical.)
    const ready = !!e && e.ready;
    this.recordEvent(ready);
    if (!ready) { this.misses++; return -1; }
    this.hits++;
    e!.lastAccessedMs = ++this.accessTicker;
    return e!.textureHandle;
  }

  /** Presence check that records nothing and doesn't touch LRU order.
   *  For internal bookkeeping (e.g. prefetch "is this already cached?"). */
  has(frameIdx: number): boolean {
    return this.entries.has(frameIdx);
  }

  private recordEvent(hit: boolean): void {
    this.events.push({ t: this.now(), hit });
    // Safety cap for the case where stats() isn't called for a long time
    // (the testbed calls it every frame, but be defensive).
    if (this.events.length > 4096) this.pruneEvents(this.now());
  }

  private pruneEvents(nowMs: number): void {
    const cutoff = nowMs - this.recentWindowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop].t < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
  }

  /** Allocate (or recycle) a texture for `frameIdx`. Returns the new
   *  handle; the caller writes pixels into it. If `frameIdx` is already
   *  cached this returns the existing handle without reallocating. */
  reserve(frameIdx: number, width: number, height: number, formatCode: number): number {
    const existing = this.entries.get(frameIdx);
    if (existing) {
      existing.lastAccessedMs = ++this.accessTicker;
      return existing.textureHandle;
    }
    const sizeBytes = width * height * (FORMAT_BPP[formatCode] ?? 4);
    this.ensureRoomFor(sizeBytes);
    const handle = this.gpuHost.createTexture(width, height, formatCode);
    this.entries.set(frameIdx, {
      frameIdx, textureHandle: handle, sizeBytes,
      lastAccessedMs: ++this.accessTicker,
      ready: false,
    });
    this.bytesUsed += sizeBytes;
    return handle;
  }

  /** Mark a reserved entry's pixels valid — call once the decode that
   *  filled its texture has completed. No-op if the entry was evicted in
   *  the meantime. */
  markReady(frameIdx: number): void {
    const e = this.entries.get(frameIdx);
    if (e) e.ready = true;
  }

  /** Replace the pinned set wholesale. Frames removed from the pinned
   *  set drop to LRU (still cached, just evictable). Frames newly in
   *  the pinned set become non-evictable until LRU is exhausted. */
  setPinned(frames: Iterable<number>): void {
    this.pinned = new Set(frames);
  }

  /** True iff `frameIdx` is currently in the pinned set. */
  isPinned(frameIdx: number): boolean {
    return this.pinned.has(frameIdx);
  }

  stats(): FrameCacheStats {
    const total = this.hits + this.misses;
    // Prune to the rolling window, then count what remains.
    this.pruneEvents(this.now());
    let recentHits = 0;
    let recentMisses = 0;
    for (const e of this.events) {
      if (e.hit) recentHits++; else recentMisses++;
    }
    const recentTotal = recentHits + recentMisses;
    return {
      bytes: this.bytesUsed,
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      recentHits,
      recentMisses,
      recentHitRate: recentTotal === 0 ? 0 : recentHits / recentTotal,
      pinnedEvicted: this.pinnedEvicted,
    };
  }

  /** Frame indices currently resident (any set, pinned or LRU). Sorted
   *  ascending for stable iteration. Used by the testbed to draw the
   *  cache map on the timeline. */
  cachedFrameIndices(): number[] {
    return Array.from(this.entries.keys()).sort((a, b) => a - b);
  }

  /** Frame indices currently in the pinned set. */
  pinnedFrameIndices(): number[] {
    return Array.from(this.pinned).sort((a, b) => a - b);
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.events = [];
    this.pinnedEvicted = false;
  }

  /** Drop all entries, release every texture. */
  clear(): void {
    for (const e of this.entries.values()) this.gpuHost.release(e.textureHandle);
    this.entries.clear();
    this.pinned.clear();
    this.bytesUsed = 0;
    this.hits = this.misses = 0;
    this.events = [];
    this.pinnedEvicted = false;
  }

  /** Bytes resident — exposed for the playback service's debug snapshot. */
  get currentBytes(): number { return this.bytesUsed; }

  // --- Internal: eviction ---

  private ensureRoomFor(extraBytes: number): void {
    if (this.bytesUsed + extraBytes <= this.budgetBytes) return;
    // Evict LRU entries (non-pinned) oldest-first until we fit.
    const lruEntries = this.collectByAge(/*pinnedOnly=*/false);
    for (const e of lruEntries) {
      if (this.bytesUsed + extraBytes <= this.budgetBytes) return;
      this.evict(e);
    }
    // Still over budget? Pinned alone exceeds budget; force-evict
    // pinned oldest-first as a last resort.
    if (this.bytesUsed + extraBytes > this.budgetBytes) {
      const pinnedEntries = this.collectByAge(/*pinnedOnly=*/true);
      for (const e of pinnedEntries) {
        if (this.bytesUsed + extraBytes <= this.budgetBytes) return;
        this.evict(e);
        this.pinnedEvicted = true;
      }
    }
  }

  /** Returns entries ordered oldest → newest. With caches in the tens of
   *  entries a single sort per eviction is cheaper than maintaining a
   *  proper doubly-linked list. */
  private collectByAge(pinnedOnly: boolean): Entry[] {
    const out: Entry[] = [];
    for (const e of this.entries.values()) {
      // Never evict an entry whose decode is still in flight — its texture
      // is being written to right now; freeing it would corrupt the write.
      if (!e.ready) continue;
      const isPinned = this.pinned.has(e.frameIdx);
      if (isPinned === pinnedOnly) out.push(e);
    }
    out.sort((a, b) => a.lastAccessedMs - b.lastAccessedMs);
    return out;
  }

  private evict(e: Entry): void {
    this.gpuHost.release(e.textureHandle);
    this.entries.delete(e.frameIdx);
    this.bytesUsed -= e.sizeBytes;
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
