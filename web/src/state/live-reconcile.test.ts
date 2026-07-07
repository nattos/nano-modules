import { describe, it, expect } from 'vitest';
import { sketchContentEqual, moreRecent, reconcileDecision } from './live-reconcile';
import type { Sketch } from '../sketch-types';
import type { LiveCacheRecord } from './live-cache-store';

function sketch(overrides: Partial<Sketch> = {}): Sketch {
  return { anchor: null, chain: [], wires: [], instances: {}, ...overrides };
}

function cacheRecord(overrides: Partial<LiveCacheRecord> = {}): LiveCacheRecord {
  return { key: 'k1', label: 'Instance 1', sketch: sketch(), updatedAt: 0, dirty: false, ...overrides };
}

describe('sketchContentEqual', () => {
  it('ignores key insertion order', () => {
    const a = { anchor: null, chain: [], wires: [] } as Sketch;
    const b = { wires: [], anchor: null, chain: [] } as Sketch;
    expect(sketchContentEqual(a, b)).toBe(true);
  });

  it('ignores lastModified differences', () => {
    const a = sketch({ lastModified: 100 });
    const b = sketch({ lastModified: 200 });
    expect(sketchContentEqual(a, b)).toBe(true);
  });

  it('detects real content differences', () => {
    const a = sketch({ chain: [] });
    const b = sketch({ chain: [{ type: 'module', instance_key: 'x', module_type: 'y' } as any] });
    expect(sketchContentEqual(a, b)).toBe(false);
  });

  it('array order is semantically meaningful', () => {
    const a = sketch({ chain: [{ type: 'module', instance_key: 'a', module_type: 't' } as any, { type: 'module', instance_key: 'b', module_type: 't' } as any] });
    const b = sketch({ chain: [{ type: 'module', instance_key: 'b', module_type: 't' } as any, { type: 'module', instance_key: 'a', module_type: 't' } as any] });
    expect(sketchContentEqual(a, b)).toBe(false);
  });
});

describe('moreRecent', () => {
  it('picks the larger timestamp', () => {
    expect(moreRecent(100, 200)).toBe('canonical');
    expect(moreRecent(200, 100)).toBe('cached');
  });

  it('unknown when either side is missing', () => {
    expect(moreRecent(undefined, 100)).toBe('unknown');
    expect(moreRecent(100, undefined)).toBe('unknown');
    expect(moreRecent(undefined, undefined)).toBe('unknown');
  });

  it('unknown when equal', () => {
    expect(moreRecent(100, 100)).toBe('unknown');
  });
});

describe('reconcileDecision', () => {
  it('adopts canonical when there is no cache', () => {
    expect(reconcileDecision({ cached: null, canonical: sketch() })).toEqual({
      action: 'adopt-canonical', recommended: 'canonical',
    });
  });

  it('adopts canonical when the cache is not dirty, even if content differs', () => {
    const cached = cacheRecord({ dirty: false, sketch: sketch({ anchor: 'a' }) });
    const canonical = sketch({ anchor: 'b' });
    expect(reconcileDecision({ cached, canonical })).toEqual({
      action: 'adopt-canonical', recommended: 'canonical',
    });
  });

  it('adopts canonical when dirty but content is identical', () => {
    const cached = cacheRecord({ dirty: true, sketch: sketch({ anchor: 'a', lastModified: 50 }) });
    const canonical = sketch({ anchor: 'a', lastModified: 999 });
    expect(reconcileDecision({ cached, canonical })).toEqual({
      action: 'adopt-canonical', recommended: 'canonical',
    });
  });

  it('conflicts when dirty and content differs, recommending the more recent side', () => {
    const cached = cacheRecord({ dirty: true, sketch: sketch({ anchor: 'a', lastModified: 200 }) });
    const canonical = sketch({ anchor: 'b', lastModified: 100 });
    expect(reconcileDecision({ cached, canonical })).toEqual({
      action: 'conflict', recommended: 'cached',
    });
  });

  it('conflicts and recommends canonical when recency is unknown', () => {
    const cached = cacheRecord({ dirty: true, sketch: sketch({ anchor: 'a' }) });
    const canonical = sketch({ anchor: 'b' });
    expect(reconcileDecision({ cached, canonical })).toEqual({
      action: 'conflict', recommended: 'canonical',
    });
  });
});
