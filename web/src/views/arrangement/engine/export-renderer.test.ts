/**
 * Unit tests for the PURE export scheduling/helpers (planExportFrames + the small
 * numeric helpers). The GPU/encoder loop needs a real browser (WebGPU + WebCodecs)
 * and isn't exercised here — but the timing math, which decides exactly which beat
 * each output frame samples, is fully testable against a WarpClock.
 */
import { describe, it, expect } from 'vitest';
import { planExportFrames, defaultBitrate, frameTimestampMicros, evenDim } from './export-renderer';
import { WarpClock, makeWarpClock } from './warp-clock';
import { WarpCurve } from '../model/beat-grid';
import { emptyComposition } from '../model/composition';

/** An un-warped clock: beat = units, so secondsAt is linear at the given bpm. */
function flatClock(bpm: number, totalBeats: number): WarpClock {
  return new WarpClock(new WarpCurve([], totalBeats), bpm);
}

describe('planExportFrames', () => {
  it('produces round(durationSec * fps) frames, time-uniform', () => {
    const clock = flatClock(120, 16); // 0.5 s/beat → 16 beats = 8 s
    const fps = 30;
    const frames = planExportFrames(clock, fps, 0, 16);
    expect(frames.length).toBe(8 * 30); // 240
    expect(frames[0]).toMatchObject({ index: 0, tSec: 0, beat: 0 });
    // Uniform 1/fps spacing in real seconds.
    expect(frames[1].tSec).toBeCloseTo(1 / 30, 9);
    expect(frames[frames.length - 1].tSec).toBeCloseTo(239 / 30, 9);
  });

  it('maps each frame time back to its beat (linear, no warp)', () => {
    const clock = flatClock(120, 8); // 0.5 s/beat
    const frames = planExportFrames(clock, 60, 0, 8);
    // At t = 1 s (frame 60) the beat is 2 (1 / 0.5).
    expect(frames[60].beat).toBeCloseTo(2, 6);
  });

  it('honours a sub-range [startBeat, endBeat]', () => {
    const clock = flatClock(120, 32);
    const frames = planExportFrames(clock, 30, 4, 8); // 4 beats = 2 s
    expect(frames.length).toBe(60);
    expect(frames[0].beat).toBeCloseTo(4, 6);
    // Last frame sits just under beat 8.
    expect(frames[frames.length - 1].beat).toBeLessThan(8);
    expect(frames[frames.length - 1].beat).toBeGreaterThan(7.9);
  });

  it('always yields at least one frame for a degenerate range', () => {
    const clock = flatClock(120, 8);
    expect(planExportFrames(clock, 30, 4, 4).length).toBe(1);
  });

  it('a warp redistributes frames in time but not the beat→time mapping', () => {
    // A real composition with no warps still round-trips beat↔seconds.
    const clock = makeWarpClock(emptyComposition());
    const frames = planExportFrames(clock, 24, 0, 4);
    // Monotonic non-decreasing beats.
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].beat).toBeGreaterThanOrEqual(frames[i - 1].beat);
    }
    // beatAtSeconds(secondsAt(beat)) is the identity → frame 0 is beat 0.
    expect(frames[0].beat).toBeCloseTo(0, 6);
  });
});

describe('export numeric helpers', () => {
  it('defaultBitrate scales with pixels × fps and floors at 1 Mbps', () => {
    const hd60 = defaultBitrate(1920, 1080, 60);
    expect(hd60).toBeGreaterThan(10_000_000);
    expect(defaultBitrate(16, 16, 1)).toBe(1_000_000); // tiny → floor
    expect(defaultBitrate(1920, 1080, 60)).toBeGreaterThan(defaultBitrate(1920, 1080, 30));
  });

  it('frameTimestampMicros is exact frame ticks in microseconds', () => {
    expect(frameTimestampMicros(0, 30)).toBe(0);
    expect(frameTimestampMicros(30, 30)).toBe(1_000_000);
    expect(frameTimestampMicros(1, 60)).toBe(Math.round(1_000_000 / 60));
  });

  it('evenDim rounds up to an even integer ≥ 2', () => {
    expect(evenDim(1919)).toBe(1920);
    expect(evenDim(1080)).toBe(1080);
    expect(evenDim(1)).toBe(2);
    expect(evenDim(0)).toBe(2);
    expect(evenDim(721)).toBe(722);
  });
});
