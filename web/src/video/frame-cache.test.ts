import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FrameCache, type GpuHostLike } from './frame-cache';

function makeMockHost(): GpuHostLike & { released: number[]; created: number[] } {
  const released: number[] = [];
  const created: number[] = [];
  let next = 100;
  return {
    released,
    created,
    createTexture: vi.fn((_w: number, _h: number, _fmt: number) => {
      const h = next++;
      created.push(h);
      return h;
    }),
    release: vi.fn((h: number) => { released.push(h); }),
  };
}

const W = 1920, H = 1080;
const FRAME_BYTES = W * H * 4;          // 8.3 MB
const FMT_RGBA8 = 1;

/** Reserve a frame AND mark it decoded — the steady-state pairing in the
 *  service (reserve → decode → markReady). Tests that care about a frame
 *  being servable/evictable use this; tests probing the in-flight window
 *  call `reserve` alone. */
function put(c: FrameCache, idx: number): number {
  const h = c.reserve(idx, W, H, FMT_RGBA8);
  c.markReady(idx);
  return h;
}

describe('FrameCache basic ops', () => {
  it('miss + reserve + lookup hits the same handle', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);

    expect(c.lookup(5)).toBe(-1);
    const h = put(c, 5);
    expect(h).toBeGreaterThan(0);
    expect(c.lookup(5)).toBe(h);

    const s = c.stats();
    expect(s.entries).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });

  it('reserve on an already-cached frame returns the same handle', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);
    const h1 = c.reserve(5, W, H, FMT_RGBA8);
    const h2 = c.reserve(5, W, H, FMT_RGBA8);
    expect(h1).toBe(h2);
    expect(host.created.length).toBe(1);
  });
});

describe('FrameCache LRU eviction', () => {
  it('evicts oldest non-pinned entry when budget is exceeded', () => {
    const host = makeMockHost();
    // Budget for exactly 2 frames.
    const c = new FrameCache(host, 2 * FRAME_BYTES);
    const a = put(c, 0);
    const b = put(c, 1);
    const cc = put(c, 2);   // evicts 0 (oldest)
    expect(host.released).toContain(a);
    expect(c.lookup(0)).toBe(-1);
    expect(c.lookup(1)).toBe(b);
    expect(c.lookup(2)).toBe(cc);
  });

  it('lookup updates LRU position so the touched frame survives', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 2 * FRAME_BYTES);
    const a = put(c, 0);
    const b = put(c, 1);
    expect(c.lookup(0)).toBe(a);      // touch 0 → now 1 is older
    put(c, 2);                        // should evict 1, not 0
    expect(c.lookup(0)).toBe(a);
    expect(c.lookup(1)).toBe(-1);
  });
});

describe('FrameCache pinned set', () => {
  it('does not evict pinned frames when LRU has capacity to give', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 3 * FRAME_BYTES);
    const a = put(c, 0);
    const b = put(c, 1);
    c.setPinned([0]);                  // pin frame 0
    put(c, 2);                         // fits, no eviction
    put(c, 3);                         // budget pressure → evict 1 (LRU non-pinned)
    expect(c.lookup(0)).toBe(a);       // still here
    expect(c.lookup(1)).toBe(-1);      // evicted
    expect(host.released).toContain(b);
  });

  it('force-evicts pinned oldest-first when pinned alone exceeds budget', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 2 * FRAME_BYTES);
    const a = put(c, 0);
    const b = put(c, 1);
    c.setPinned([0, 1]);
    put(c, 2);                         // both pinned → must evict one
    const stats = c.stats();
    expect(stats.pinnedEvicted).toBe(true);
    // The newly-reserved frame must be present.
    expect(c.lookup(2)).toBeGreaterThan(0);
  });
});

describe('FrameCache stats', () => {
  it('hitRate reflects ongoing requests', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);
    put(c, 0);                         // reserve+ready doesn't touch counters
    c.lookup(0);                       // hit
    c.lookup(0);                       // hit
    c.lookup(99);                      // miss
    const s = c.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3);
  });

  it('resetStats clears counters without dropping textures', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);
    put(c, 0);
    c.lookup(0);
    c.resetStats();
    const s = c.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.recentHits).toBe(0);
    expect(s.recentMisses).toBe(0);
    expect(s.entries).toBe(1);         // texture still resident
  });

  it('has() peeks without recording a hit/miss or bumping LRU', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);
    c.reserve(5, W, H, FMT_RGBA8);
    expect(c.has(5)).toBe(true);
    expect(c.has(6)).toBe(false);
    const s = c.stats();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);          // has() recorded nothing
  });
});

describe('FrameCache rolling 1-second stats', () => {
  it('reports only the hits/misses within the recent window', () => {
    const host = makeMockHost();
    let clock = 0;
    const c = new FrameCache(host, 100 * 1024 * 1024,
      { now: () => clock, recentWindowMs: 1000 });
    put(c, 0);

    // t=0..400ms: 3 hits, 1 miss (cumulative + recent both see them).
    clock = 0;   c.lookup(0);   // hit
    clock = 100; c.lookup(0);   // hit
    clock = 200; c.lookup(99);  // miss
    clock = 400; c.lookup(0);   // hit
    let s = c.stats();
    expect(s.recentHits).toBe(3);
    expect(s.recentMisses).toBe(1);
    expect(s.recentHitRate).toBeCloseTo(0.75);

    // Advance past the window so the early events age out, then do one
    // fresh miss. Recent should reflect ONLY the new event; cumulative
    // keeps everything.
    clock = 1500; c.lookup(98);  // miss (events before t=500 now stale)
    s = c.stats();
    expect(s.recentHits).toBe(0);
    expect(s.recentMisses).toBe(1);
    expect(s.recentHitRate).toBe(0);
    // Cumulative still counts the whole history.
    expect(s.hits).toBe(3);
    expect(s.misses).toBe(2);
  });

  it('recent rate recovers as new hits land in the window', () => {
    const host = makeMockHost();
    let clock = 0;
    const c = new FrameCache(host, 100 * 1024 * 1024,
      { now: () => clock, recentWindowMs: 1000 });
    put(c, 0);
    // A burst of misses long ago.
    clock = 0; c.lookup(1); c.lookup(2); c.lookup(3);
    // Now, a second later, all hits.
    clock = 1100; c.lookup(0);
    clock = 1200; c.lookup(0);
    const s = c.stats();
    expect(s.recentHits).toBe(2);
    expect(s.recentMisses).toBe(0);   // old misses aged out
    expect(s.recentHitRate).toBe(1);
  });
});

describe('FrameCache readiness gate', () => {
  it('treats a reserved-but-not-ready entry as a miss until markReady', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);
    const h = c.reserve(7, W, H, FMT_RGBA8);   // reserved, decode in flight
    expect(c.lookup(7)).toBe(-1);              // still black → miss, not a hit
    c.markReady(7);                            // decode done
    expect(c.lookup(7)).toBe(h);               // now servable
  });

  it('does not evict an in-flight (not-ready) entry under budget pressure', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 2 * FRAME_BYTES);
    const a = c.reserve(0, W, H, FMT_RGBA8);   // in flight
    const b = c.reserve(1, W, H, FMT_RGBA8);   // in flight
    // Budget is full and both residents are mid-decode; a third reserve
    // must not free either (freeing a texture being written corrupts it).
    c.reserve(2, W, H, FMT_RGBA8);
    expect(host.released).not.toContain(a);
    expect(host.released).not.toContain(b);
  });
});

describe('FrameCache clear', () => {
  it('releases every texture and zeroes the byte counter', () => {
    const host = makeMockHost();
    const c = new FrameCache(host, 100 * 1024 * 1024);
    c.reserve(0, W, H, FMT_RGBA8);
    c.reserve(1, W, H, FMT_RGBA8);
    c.clear();
    expect(host.released.length).toBe(2);
    expect(c.stats().entries).toBe(0);
    expect(c.currentBytes).toBe(0);
  });
});
