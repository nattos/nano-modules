import { describe, it, expect } from 'vitest';
import { computeReadAheadTargets } from './read-ahead';

const FC = 250;   // frame count
const D = 5;      // depth

describe('computeReadAheadTargets — direction follows motion', () => {
  it('Sequential mode, moving forward → pre-caches the next frames', () => {
    const t = computeReadAheadTargets({
      mode: 'Sequential', frameIdx: 100, frameCount: FC, motionDir: 1, depth: D,
    });
    expect(t).toEqual([101, 102, 103, 104, 105]);
  });

  it('Sequential mode but moving BACKWARD → pre-caches behind (ping-pong reverse leg)', () => {
    // The classifier still says Sequential (it lags the turn), but the
    // playhead just reversed. Read-ahead must follow the actual motion.
    const t = computeReadAheadTargets({
      mode: 'Sequential', frameIdx: 100, frameCount: FC, motionDir: -1, depth: D,
    });
    expect(t).toEqual([99, 98, 97, 96, 95]);
  });

  it('Reverse mode but moving FORWARD → pre-caches ahead', () => {
    const t = computeReadAheadTargets({
      mode: 'Reverse', frameIdx: 100, frameCount: FC, motionDir: 1, depth: D,
    });
    expect(t).toEqual([101, 102, 103, 104, 105]);
  });

  it('Reverse mode, moving backward → pre-caches behind', () => {
    const t = computeReadAheadTargets({
      mode: 'Reverse', frameIdx: 100, frameCount: FC, motionDir: -1, depth: D,
    });
    expect(t).toEqual([99, 98, 97, 96, 95]);
  });

  it('clamps targets to the valid frame range', () => {
    // Near the end, forward read-ahead truncates at frameCount-1.
    const t = computeReadAheadTargets({
      mode: 'Sequential', frameIdx: 247, frameCount: FC, motionDir: 1, depth: D,
    });
    expect(t).toEqual([248, 249]);
    // Near the start, backward read-ahead truncates at 0.
    const u = computeReadAheadTargets({
      mode: 'Sequential', frameIdx: 2, frameCount: FC, motionDir: -1, depth: D,
    });
    expect(u).toEqual([1, 0]);
  });

  it('defaults to forward when motionDir is 0 (not yet moved)', () => {
    const t = computeReadAheadTargets({
      mode: 'Sequential', frameIdx: 10, frameCount: FC, motionDir: 0, depth: D,
    });
    expect(t).toEqual([11, 12, 13, 14, 15]);
  });
});

describe('computeReadAheadTargets — other modes', () => {
  it('Strided pre-caches at the detected stride', () => {
    const t = computeReadAheadTargets({
      mode: 'Strided', frameIdx: 0, frameCount: FC, motionDir: 1, depth: 3, stride: 5,
    });
    expect(t).toEqual([5, 10, 15]);
  });

  it('Loop does a light single-frame read-ahead (range is pinned)', () => {
    const t = computeReadAheadTargets({
      mode: 'Loop', frameIdx: 40, frameCount: FC, motionDir: 1, depth: D,
    });
    expect(t).toEqual([41]);
  });

  it('Scrub pre-caches a small window on both sides', () => {
    const t = computeReadAheadTargets({
      mode: 'Scrub', frameIdx: 40, frameCount: FC, motionDir: 1, depth: D,
    });
    expect(t.sort((a, b) => a - b)).toEqual([39, 41]);
  });

  it('Random and Hotspots do no read-ahead', () => {
    expect(computeReadAheadTargets({
      mode: 'Random', frameIdx: 40, frameCount: FC, motionDir: 1, depth: D,
    })).toEqual([]);
    expect(computeReadAheadTargets({
      mode: 'Hotspots', frameIdx: 40, frameCount: FC, motionDir: 1, depth: D,
    })).toEqual([]);
  });
});
