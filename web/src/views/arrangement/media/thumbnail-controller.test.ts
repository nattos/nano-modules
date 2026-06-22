import { describe, it, expect } from 'vitest';
import { reelLayout } from './thumbnail-controller';
import { levelForFramesPerThumb } from './thumbnail-mip';

describe('reelLayout', () => {
  it('returns nothing for a degenerate strip', () => {
    expect(reelLayout(0, 40, 100).cells).toBe(0);
    expect(reelLayout(200, 1, 100).cells).toBe(0);
    expect(reelLayout(200, 40, 0).cells).toBe(0);
  });

  it('fits ~16:9 cells across the width and one frame per cell', () => {
    const h = 36;
    const w = 800;
    const lay = reelLayout(w, h, 57);
    // Cell width ≈ h*16/9 ≈ 64 → ~12-13 cells across 800px.
    const cellW = h * (16 / 9);
    expect(lay.cells).toBe(Math.round(w / cellW));
    expect(lay.frames.length).toBe(lay.cells);
  });

  it('maps cells to monotonically increasing in-range source frames', () => {
    const lay = reelLayout(600, 40, 57);
    const last = 56;
    for (const f of lay.frames) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(last);
    }
    for (let i = 1; i < lay.frames.length; i++) {
      expect(lay.frames[i]).toBeGreaterThanOrEqual(lay.frames[i - 1]);
    }
    // First cell near the start, last cell near the end.
    expect(lay.frames[0]).toBeLessThan(last / 2);
    expect(lay.frames[lay.frames.length - 1]).toBeGreaterThan(last / 2);
  });

  it('picks the mip level matching frames-per-cell granularity', () => {
    const lay = reelLayout(400, 40, 240);
    const framesPerCell = 240 / lay.cells;
    expect(lay.level).toBe(levelForFramesPerThumb(framesPerCell));
  });
});
