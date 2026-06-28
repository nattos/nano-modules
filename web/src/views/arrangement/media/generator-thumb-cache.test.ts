import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatorThumbCache, setGeneratorThumbPersist } from './generator-thumb-cache';

// jsdom has no real ImageBitmap; the cache only stores them + calls .close().
const bmp = () => ({ close: vi.fn() } as unknown as ImageBitmap);

beforeEach(() => { generatorThumbCache.clear(); setGeneratorThumbPersist(null); });

describe('generatorThumbCache', () => {
  it('peek / put / has / count', () => {
    expect(generatorThumbCache.peek('fp', 0)).toBeUndefined();
    const b = bmp();
    generatorThumbCache.put('fp', 3, b);
    expect(generatorThumbCache.has('fp', 3)).toBe(true);
    expect(generatorThumbCache.has('fp', 0)).toBe(false);
    expect(generatorThumbCache.peek('fp', 3)).toBe(b);
    expect(generatorThumbCache.count('fp')).toBe(1);
  });

  it('peekBest: fresh exact, stale nearest, stale cross-fingerprint fallback', () => {
    expect(generatorThumbCache.peekBest(['cur'], 12)).toBeUndefined();

    // Current fingerprint, exact sample → fresh.
    const exact = bmp();
    generatorThumbCache.put('cur', 12, exact);
    expect(generatorThumbCache.peekBest(['cur'], 12)).toEqual({ bitmap: exact, stale: false });

    // Current fingerprint, only a NEARBY sample → stale (wrong time).
    const near = bmp();
    generatorThumbCache.put('cur', 5, near);
    expect(generatorThumbCache.peekBest(['cur'], 7)).toEqual({ bitmap: near, stale: true }); // 7→nearest of {12,5}=5
    expect(generatorThumbCache.peekBest(['cur'], 12)).toEqual({ bitmap: exact, stale: false }); // exact still fresh

    // After a param change: current 'new' has nothing yet → fall back to old 'cur'
    // at the RIGHT time (sample 12), marked stale.
    expect(generatorThumbCache.peekBest(['new', 'cur'], 12)).toEqual({ bitmap: exact, stale: true });
    // No exact anywhere for sample 30 → nearest from the most-recent non-empty fp.
    expect(generatorThumbCache.peekBest(['new', 'cur'], 30)?.stale).toBe(true);
  });

  it('replacing a sample closes the stale bitmap', () => {
    const b1 = bmp();
    const b2 = bmp();
    generatorThumbCache.put('fp', 0, b1);
    generatorThumbCache.put('fp', 0, b2);
    expect(b1.close).toHaveBeenCalled();
    expect(generatorThumbCache.peek('fp', 0)).toBe(b2);
    expect(generatorThumbCache.count('fp')).toBe(1);
  });

  it('subscribe fires on put and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = generatorThumbCache.subscribe(fn);
    generatorThumbCache.put('fp', 0, bmp());
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    generatorThumbCache.put('fp', 1, bmp());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('LRU evicts the oldest UNtouched fingerprint and closes its bitmaps', () => {
    const first = bmp();
    generatorThumbCache.put('fp0', 0, first);          // oldest
    for (let i = 1; i <= 64; i++) generatorThumbCache.put('fp' + i, 0, bmp()); // cap is 64
    expect(first.close).toHaveBeenCalled();
    expect(generatorThumbCache.peek('fp0', 0)).toBeUndefined();
    expect(generatorThumbCache.peek('fp64', 0)).toBeDefined();
  });

  it('put persists to the disk tier; prefetch repopulates memory from it', async () => {
    const disk = new Map<string, ImageBitmap>();
    setGeneratorThumbPersist({
      write: async (k, b) => { disk.set(k, b); },
      read: async (k) => disk.get(k) ?? null,
    });
    const b = bmp();
    generatorThumbCache.put('fpX', 7, b);
    expect([...disk.keys()][0]).toMatch(/^g.+#7$/); // hashed `g<hash>#<sample>` key

    // Lose the memory tier (e.g. an app restart), then warm it back from disk.
    generatorThumbCache.clear();
    setGeneratorThumbPersist({ write: async () => {}, read: async (k) => disk.get(k) ?? null });
    expect(generatorThumbCache.peek('fpX', 7)).toBeUndefined();
    generatorThumbCache.prefetch('fpX', [7]);
    await new Promise((r) => setTimeout(r, 0)); // let the async disk read resolve
    expect(generatorThumbCache.peek('fpX', 7)).toBe(b);
  });

  it('fill keeps a live-captured sample over a slower disk read', () => {
    const captured = bmp();
    const fromDisk = bmp();
    generatorThumbCache.put('fp', 3, captured);
    generatorThumbCache.fill('fp', 3, fromDisk); // disk read lands after capture
    expect(fromDisk.close).toHaveBeenCalled();    // disk copy dropped
    expect(generatorThumbCache.peek('fp', 3)).toBe(captured);
  });

  it('peek touches LRU so a recently-read fingerprint survives eviction', () => {
    const keep = bmp();
    generatorThumbCache.put('keep', 0, keep);
    // Fill to capacity, touching `keep` along the way so it isn't the oldest.
    for (let i = 0; i < 40; i++) generatorThumbCache.put('x' + i, 0, bmp());
    generatorThumbCache.peek('keep', 0); // touch → most-recent
    for (let i = 40; i < 80; i++) generatorThumbCache.put('x' + i, 0, bmp());
    expect(keep.close).not.toHaveBeenCalled();
    expect(generatorThumbCache.peek('keep', 0)).toBe(keep);
  });
});
