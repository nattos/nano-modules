import { describe, it, expect } from 'vitest';
import { layoutFloaters, floatersOverlap, type Floater } from './floating-layout';

const box = (id: string, pos: { x: number; y: number }, w = 20, h = 20) =>
  ({ x: pos.x, y: pos.y, width: w, height: h });

describe('layoutFloaters', () => {
  it('leaves a single floater at its anchor', () => {
    const r = layoutFloaters([{ id: 'a', anchorX: 100, anchorY: 50, width: 20, height: 20 }]);
    expect(r.get('a')).toEqual({ x: 100, y: 50 });
  });

  it('separates two floaters that share an anchor', () => {
    const items: Floater[] = [
      { id: 'a', anchorX: 0, anchorY: 0, width: 20, height: 20 },
      { id: 'b', anchorX: 0, anchorY: 0, width: 20, height: 20 },
    ];
    const r = layoutFloaters(items);
    expect(floatersOverlap(box('a', r.get('a')!), box('b', r.get('b')!))).toBe(false);
  });

  it('keeps a clustered row non-overlapping', () => {
    const items: Floater[] = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`, anchorX: i * 4, anchorY: 0, width: 20, height: 14, weightX: 0.2, weightY: 5,
    }));
    const r = layoutFloaters(items);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = box(`n${i}`, r.get(`n${i}`)!, 20, 14);
        const b = box(`n${j}`, r.get(`n${j}`)!, 20, 14);
        expect(floatersOverlap(a, b)).toBe(false);
      }
    }
  });

  it('respects a high Y-weight: badges slide in X but stay in the Y band', () => {
    // Low weightX, high weightY → overlaps resolve in X, Y pinned to the anchor band.
    const items: Floater[] = [
      { id: 'a', anchorX: 0, anchorY: 30, width: 30, height: 14, weightX: 0.2, weightY: 50 },
      { id: 'b', anchorX: 5, anchorY: 30, width: 30, height: 14, weightX: 0.2, weightY: 50 },
    ];
    const r = layoutFloaters(items);
    expect(r.get('a')!.y).toBeCloseTo(30, 1);
    expect(r.get('b')!.y).toBeCloseTo(30, 1);
    expect(Math.abs(r.get('a')!.x - r.get('b')!.x)).toBeGreaterThanOrEqual(30 - 1e-3);
  });

  it('moves the lower-weight item more than the high-weight one', () => {
    const items: Floater[] = [
      // High weightY on both → X is the cheaper axis, so they separate in X.
      { id: 'fixed', anchorX: 0, anchorY: 0, width: 20, height: 20, weightX: 100, weightY: 100 },
      { id: 'free', anchorX: 0, anchorY: 0, width: 20, height: 20, weightX: 0.1, weightY: 100 },
    ];
    const r = layoutFloaters(items);
    const fixedShift = Math.abs(r.get('fixed')!.x - 0);
    const freeShift = Math.abs(r.get('free')!.x - 0);
    expect(freeShift).toBeGreaterThan(fixedShift);
    expect(fixedShift).toBeLessThan(2); // high weight barely budges
  });

  it('is deterministic', () => {
    const items: Floater[] = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`, anchorX: (i % 3) * 6, anchorY: Math.floor(i / 3) * 3, width: 20, height: 16,
    }));
    const a = layoutFloaters(items);
    const b = layoutFloaters(items);
    for (const k of a.keys()) expect(b.get(k)).toEqual(a.get(k));
  });

  it('clamps to bounds', () => {
    const r = layoutFloaters(
      [{ id: 'a', anchorX: 1000, anchorY: 1000, width: 20, height: 20 }],
      { bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } },
    );
    expect(r.get('a')!.x).toBeLessThanOrEqual(90);
    expect(r.get('a')!.y).toBeLessThanOrEqual(90);
  });
});
