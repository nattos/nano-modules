import { describe, it, expect } from 'vitest';
import { BeatGrid, WarpCurve, gridStepBeats, GRID_MIN_PX } from './beat-grid';

/**
 * The grid step is the SINGLE source of truth for the drawn lines AND the snap
 * quantization — "what you see is what you snap to". These pin the ladder and
 * the invariant that every drawn line is at least GRID_MIN_PX from its neighbour.
 */
describe('gridStepBeats', () => {
  it('never packs lines closer than the minimum spacing', () => {
    for (let ppb = 2; ppb <= 800; ppb += 3) {
      const step = gridStepBeats(ppb, 4);
      expect(step * ppb).toBeGreaterThanOrEqual(GRID_MIN_PX - 1e-9);
    }
  });

  it('halves below a beat, then climbs in BARS (no off-bar multiples)', () => {
    expect(gridStepBeats(22, 4)).toBe(1);       // exactly one beat per MIN px
    expect(gridStepBeats(50, 4)).toBe(0.5);
    expect(gridStepBeats(100, 4)).toBe(0.25);
    expect(gridStepBeats(200, 4)).toBe(0.125);
    expect(gridStepBeats(15, 4)).toBe(4);       // a bar, not 2 beats
    expect(gridStepBeats(4, 4)).toBe(8);        // 2 bars
  });

  it('follows the meter for bar-sized steps', () => {
    expect(gridStepBeats(15, 3)).toBe(3);       // 3/4 → one bar is 3 beats
    expect(gridStepBeats(4, 3)).toBe(6);        // 2 bars
    expect(gridStepBeats(2, 3)).toBe(12);       // 4 bars
  });

  it('clamps to the finest subdivision when zoomed absurdly far in', () => {
    expect(gridStepBeats(1e6, 4)).toBe(1 / 16);
  });
});

describe('BeatGrid.visibleBeatLines', () => {
  const grid = (ppb: number, scroll = 0) =>
    new BeatGrid(new WarpCurve([], 256), ppb, scroll);

  it('emits fractional steps without drift, tagging bars and whole beats', () => {
    const lines = grid(100).visibleBeatLines(100, 4, 0.25);
    expect(lines.map((l) => l.beat)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(lines[0]).toMatchObject({ isBar: true, isBeat: true });
    expect(lines[1]).toMatchObject({ isBar: false, isBeat: false });
    expect(lines[4]).toMatchObject({ isBar: false, isBeat: true });
  });

  it('starts at the first step at-or-before the viewport and never goes negative', () => {
    const lines = grid(20, 3.4).visibleBeatLines(40, 4, 1);
    expect(lines[0].beat).toBe(3);
    expect(lines.every((l) => l.beat >= 0)).toBe(true);
  });

  it('marks downbeats for a bar-sized step', () => {
    const lines = grid(10).visibleBeatLines(100, 4, 4);
    expect(lines.map((l) => l.beat)).toEqual([0, 4, 8]);
    expect(lines.every((l) => l.isBar && l.isBeat)).toBe(true);
  });
});
