import { describe, it, expect } from 'vitest';
import {
  strideForLevel,
  snapFrame,
  levelForFramesPerThumb,
  framesInRange,
} from './thumbnail-mip';

describe('thumbnail mip-in-time', () => {
  it('doubles stride per level', () => {
    expect(strideForLevel(0)).toBe(1);
    expect(strideForLevel(1)).toBe(2);
    expect(strideForLevel(3)).toBe(8);
    expect(strideForLevel(2, { baseStride: 4 })).toBe(16);
  });

  it('snaps frames to the nearest tile boundary (clamped ≥ 0)', () => {
    expect(snapFrame(5, 0)).toBe(5);
    expect(snapFrame(5, 2)).toBe(4); // stride 4 → nearest of {4,8}
    expect(snapFrame(7, 2)).toBe(8);
    expect(snapFrame(-3, 1)).toBe(0);
  });

  it('shares tiles across levels at coincident frames (mip sharing)', () => {
    // Frame 0 and any multiple of a coarse stride map to themselves at every
    // finer level → the same cache/store key.
    for (const L of [0, 1, 2, 3]) expect(snapFrame(0, L)).toBe(0);
    expect(snapFrame(8, 0)).toBe(8);
    expect(snapFrame(8, 3)).toBe(8); // stride 8 → 8 (shared with level 0's frame 8)
    expect(snapFrame(16, 1)).toBe(16);
    expect(snapFrame(16, 2)).toBe(16);
  });

  it('picks the coarsest level dense enough for frames-per-thumbnail', () => {
    expect(levelForFramesPerThumb(1)).toBe(0);
    expect(levelForFramesPerThumb(2)).toBe(1);
    expect(levelForFramesPerThumb(4)).toBe(2);
    expect(levelForFramesPerThumb(5)).toBe(2); // floor(log2(5)) = 2
    expect(levelForFramesPerThumb(8)).toBe(3);
  });

  it('lists the strided frames covering a range', () => {
    expect(framesInRange(0, 4, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(framesInRange(3, 12, 2)).toEqual([0, 4, 8, 12]); // snaps start down to 0
    expect(framesInRange(5, 12, 2)).toEqual([4, 8, 12]);
  });
});
