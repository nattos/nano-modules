import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatorThumbCache } from './generator-thumb-cache';

// jsdom has no real ImageBitmap; the cache only stores them + calls .close().
const bmp = () => ({ close: vi.fn() } as unknown as ImageBitmap);

beforeEach(() => generatorThumbCache.clear());

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

  it('peekNearest substitutes the closest captured sample, undefined when empty', () => {
    expect(generatorThumbCache.peekNearest('fp', 12)).toBeUndefined();
    const b5 = bmp();
    const b20 = bmp();
    generatorThumbCache.put('fp', 5, b5);
    generatorThumbCache.put('fp', 20, b20);
    expect(generatorThumbCache.peekNearest('fp', 5)).toBe(b5);   // exact
    expect(generatorThumbCache.peekNearest('fp', 11)).toBe(b5);  // 11 closer to 5
    expect(generatorThumbCache.peekNearest('fp', 16)).toBe(b20); // 16 closer to 20
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
