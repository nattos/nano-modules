import { describe, it, expect } from 'vitest';
import { CostTracker, classify } from './cost-tracker';

describe('CostTracker EWMA', () => {
  it('first sample sets the EWMA exactly, no smoothing', () => {
    const t = new CostTracker();
    t.recordPull({ stride: 1, decodeMs: 5 });
    expect(t.snapshot().meanFrameDecodeMs).toBe(5);
  });

  it('subsequent samples smooth toward the new value with α≈0.1', () => {
    const t = new CostTracker();
    t.recordPull({ stride: 1, decodeMs: 10 });
    t.recordPull({ stride: 1, decodeMs: 20 });
    // EWMA: 0.1*20 + 0.9*10 = 11
    expect(t.snapshot().meanFrameDecodeMs).toBeCloseTo(11, 5);
  });

  it('converges to the steady-state value', () => {
    const t = new CostTracker();
    for (let i = 0; i < 200; i++) t.recordPull({ stride: 1, decodeMs: 7 });
    expect(t.snapshot().meanFrameDecodeMs).toBeCloseTo(7, 3);
  });

  it('separates seek pulls from contiguous pulls', () => {
    const t = new CostTracker();
    // Contiguous: ~5ms decode
    for (let i = 0; i < 50; i++) t.recordPull({ stride: 1, decodeMs: 5 });
    // Seek: ~30ms decode (h264-ish)
    for (let i = 0; i < 50; i++) t.recordPull({ stride: 17, decodeMs: 30 });
    const s = t.snapshot();
    expect(s.meanFrameDecodeMs).toBeCloseTo(5, 1);
    expect(s.seekDecodeMs).toBeCloseTo(30, 1);
    expect(s.seekPenaltyMs).toBeCloseTo(25, 1);
  });

  it('seedFromPersisted caps sample count so new data can still nudge', () => {
    const t = new CostTracker();
    t.seedFromPersisted({
      meanFrameDecodeMs: 100, seekDecodeMs: 200, seekPenaltyMs: 100,
      firstByteLatencyMs: 0, payloadBytesPerFrame: 0,
      samples: 10_000, costClass: 'SlowDecode',
    });
    // After seeding, the next pull should still move the EWMA, not be
    // drowned out by the persisted weight.
    t.recordPull({ stride: 1, decodeMs: 5 });
    const after = t.snapshot();
    expect(after.meanFrameDecodeMs).toBeLessThan(100);   // moved toward 5
    expect(after.meanFrameDecodeMs).toBeGreaterThan(10); // but not all the way
  });
});

describe('CostTracker payload running mean', () => {
  it('payloadBytesPerFrame is a running arithmetic mean', () => {
    const t = new CostTracker();
    t.recordPull({ stride: 1, decodeMs: 5, payloadBytes: 1000 });
    t.recordPull({ stride: 1, decodeMs: 5, payloadBytes: 2000 });
    t.recordPull({ stride: 1, decodeMs: 5, payloadBytes: 3000 });
    expect(t.snapshot().payloadBytesPerFrame).toBeCloseTo(2000, 6);
  });
});

describe('classify thresholds', () => {
  it('returns Unknown until samples ≥ 32', () => {
    expect(classify(0, 5, 10)).toBe('Unknown');
    expect(classify(31, 5, 10)).toBe('Unknown');
    expect(classify(32, 5, 10)).not.toBe('Unknown');
  });

  it('FastRandom: cheap decode AND cheap seek (DXV)', () => {
    // meanDecode < 10, seekPenalty < 2 * meanDecode
    expect(classify(64, 3, 4)).toBe('FastRandom');
    expect(classify(64, 5, 9)).toBe('FastRandom');   // penalty=4 < 10
  });

  it('SlowDecode: decode dominates regardless of seek (4K / heavy codec)', () => {
    expect(classify(64, 60, 65)).toBe('SlowDecode');
    expect(classify(64, 100, 100)).toBe('SlowDecode');
  });

  it('SlowSeek: cheap decode but expensive seek (long-GOP h264)', () => {
    expect(classify(64, 5, 80)).toBe('SlowSeek');
    expect(classify(64, 8, 50)).toBe('SlowSeek');
  });

  it('SlowSeek also catches moderate-decode middle-ground cases', () => {
    // Decode is moderate (20ms) — doesn't fit FastRandom or SlowDecode.
    // Conservative default: cache aggressively, classify as SlowSeek.
    expect(classify(64, 20, 25)).toBe('SlowSeek');
  });

  it('falls back to seekDecode when meanDecode is undersampled', () => {
    // Aggressive read-ahead suppresses the contiguous-decode bucket —
    // every sequential pull is a cache hit. With only seek samples,
    // classify on those alone.
    expect(classify(64, 0, 5)).toBe('FastRandom');
    expect(classify(64, 0, 25)).toBe('SlowSeek');
    expect(classify(64, 0, 80)).toBe('SlowDecode');
  });
});

describe('CostTracker reset', () => {
  it('zeroes all state', () => {
    const t = new CostTracker();
    for (let i = 0; i < 10; i++) t.recordPull({ stride: 1, decodeMs: 5 });
    t.reset();
    const s = t.snapshot();
    expect(s.samples).toBe(0);
    expect(s.meanFrameDecodeMs).toBe(0);
    expect(s.costClass).toBe('Unknown');
  });
});
