import { describe, it, expect, vi } from 'vitest';
import { ThumbnailCache, thumbKey, type ThumbnailProducer } from './thumbnail-cache';

/** A controllable producer: records calls and resolves `produce` on demand. */
function makeProducer() {
  const calls: Array<{ sourceKey: string; frame: number }> = [];
  const resolvers = new Map<string, (v: string) => void>();
  const producer: ThumbnailProducer<string> = {
    produce(sourceKey, frame) {
      calls.push({ sourceKey, frame });
      return new Promise<string>((resolve) => {
        resolvers.set(`${sourceKey}#${frame}`, resolve);
      });
    },
  };
  const settle = (sourceKey: string, frame: number, value = `${sourceKey}:${frame}`) => {
    resolvers.get(`${sourceKey}#${frame}`)!(value);
  };
  return { producer, calls, settle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ThumbnailCache', () => {
  it('returns null on miss, schedules a fill, then serves the cached value', async () => {
    const { producer, calls, settle } = makeProducer();
    const cache = new ThumbnailCache(producer, { capacity: 10 });

    expect(cache.get('src', 5)).toBeNull();
    expect(calls).toEqual([{ sourceKey: 'src', frame: 5 }]);

    settle('src', 5);
    await tick();

    expect(cache.has('src', 5)).toBe(true);
    expect(cache.get('src', 5)).toBe('src:5');
    expect(cache.stats().hits).toBe(1);
  });

  it('fires onFill when an async fill lands', async () => {
    const { producer, settle } = makeProducer();
    const cache = new ThumbnailCache(producer, { capacity: 10 });
    const onFill = vi.fn();
    cache.onFill = onFill;

    cache.get('s', 1);
    settle('s', 1, 'thumb');
    await tick();

    expect(onFill).toHaveBeenCalledWith('s', 1, 'thumb');
  });

  it('deduplicates concurrent requests for the same key', async () => {
    const { producer, calls, settle } = makeProducer();
    const cache = new ThumbnailCache(producer);

    const a = cache.request('s', 2);
    const b = cache.request('s', 2);
    cache.get('s', 2); // miss path also routes through request()
    expect(calls.length).toBe(1);

    settle('s', 2, 'x');
    expect(await a).toBe('x');
    expect(await b).toBe('x');
  });

  it('evicts least-recently-used past capacity and disposes the evicted', async () => {
    const { producer, settle } = makeProducer();
    const disposed: string[] = [];
    const cache = new ThumbnailCache(producer, {
      capacity: 2,
      dispose: (v) => disposed.push(v),
    });

    for (const f of [1, 2, 3]) cache.get('s', f);
    settle('s', 1); settle('s', 2); settle('s', 3);
    await tick();

    // Cap 2 → the first-inserted (frame 1) is evicted.
    expect(cache.has('s', 1)).toBe(false);
    expect(cache.has('s', 2)).toBe(true);
    expect(cache.has('s', 3)).toBe(true);
    expect(disposed).toContain('s:1');
    expect(cache.stats().size).toBe(2);
  });

  it('touching an entry on get() protects it from eviction (true LRU)', async () => {
    const { producer, settle } = makeProducer();
    const cache = new ThumbnailCache(producer, { capacity: 2 });

    cache.get('s', 1); settle('s', 1);
    cache.get('s', 2); settle('s', 2);
    await tick();

    // Re-touch frame 1 so it's most-recently-used, then insert frame 3.
    expect(cache.get('s', 1)).toBe('s:1');
    cache.get('s', 3); settle('s', 3);
    await tick();

    // Frame 2 (now LRU) is evicted, frame 1 survives.
    expect(cache.has('s', 1)).toBe(true);
    expect(cache.has('s', 2)).toBe(false);
    expect(cache.has('s', 3)).toBe(true);
  });

  it('peek() reads without scheduling a fill on a miss', () => {
    const { producer, calls } = makeProducer();
    const cache = new ThumbnailCache(producer);
    expect(cache.peek('s', 1)).toBeNull();
    expect(calls.length).toBe(0); // no decode scheduled (unlike get())
  });

  it('setPinned protects entries from capacity eviction', async () => {
    const { producer, settle } = makeProducer();
    const evicted: string[] = [];
    const cache = new ThumbnailCache(producer, { capacity: 2 });
    cache.onEvict = (sk, f) => evicted.push(`${sk}#${f}`);

    cache.get('s', 1); settle('s', 1);
    cache.get('s', 2); settle('s', 2);
    await tick();

    cache.setPinned(new Set([thumbKey('s', 1)])); // pin the OLDEST entry
    cache.get('s', 3); settle('s', 3);
    cache.get('s', 4); settle('s', 4);
    await tick();

    // Capacity 2, but s#1 is pinned → survives despite being LRU.
    expect(cache.has('s', 1)).toBe(true);
    expect(cache.stats().size).toBe(2);
    expect(evicted).toContain('s#2');
  });

  it('setCapacity evicts down to the new budget immediately', async () => {
    const { producer, settle } = makeProducer();
    const cache = new ThumbnailCache(producer, { capacity: 8 });
    for (const f of [1, 2, 3, 4]) { cache.get('s', f); settle('s', f); }
    await tick();
    expect(cache.stats().size).toBe(4);
    cache.setCapacity(2);
    expect(cache.stats().size).toBe(2);
    // The two most-recently-inserted survive.
    expect(cache.has('s', 4)).toBe(true);
    expect(cache.has('s', 1)).toBe(false);
  });

  it('clear() aborts in-flight work and a superseded fill is discarded', async () => {
    const { producer, settle } = makeProducer();
    const disposed: string[] = [];
    const cache = new ThumbnailCache(producer, { dispose: (v) => disposed.push(v) });
    const onFill = vi.fn();
    cache.onFill = onFill;

    cache.get('s', 7); // in-flight
    cache.clear();      // aborts it
    settle('s', 7, 'late'); // resolves after abort
    await tick();

    expect(cache.has('s', 7)).toBe(false);
    expect(onFill).not.toHaveBeenCalled();
    expect(disposed).toContain('late'); // aborted fill's value is disposed
  });
});
