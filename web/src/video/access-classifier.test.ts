import { describe, it, expect } from 'vitest';
import { AccessClassifier } from './access-classifier';

/** Helper: feed a sequence of frame indices to the classifier with a
 *  uniform 33ms (~30fps) inter-pull spacing. */
function feed(c: AccessClassifier, frames: number[], startMs = 0): void {
  for (let i = 0; i < frames.length; i++) {
    c.recordPull(frames[i], startMs + i * 33);
  }
}

describe('AccessClassifier cold start', () => {
  it('defaults to Sequential with zero confidence', () => {
    const c = new AccessClassifier();
    const s = c.snapshot();
    expect(s.mode).toBe('Sequential');
    expect(s.confidence).toBe(0);
  });
});

describe('AccessClassifier sequential', () => {
  it('classifies contiguous forward pulls as Sequential', () => {
    const c = new AccessClassifier();
    const frames = Array.from({ length: 64 }, (_, i) => i);
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Sequential');
    expect(s.confidence).toBeGreaterThan(0.9);
  });
});

describe('AccessClassifier reverse', () => {
  it('classifies contiguous backward pulls as Reverse', () => {
    const c = new AccessClassifier();
    // Reverse is a mode switch (default is Sequential) — needs ≥32 pulls to
    // beat hysteresis.
    const frames = Array.from({ length: 64 }, (_, i) => 100 - i);
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Reverse');
    expect(s.confidence).toBeGreaterThan(0.9);
  });
});

describe('AccessClassifier strided', () => {
  it('classifies constant non-±1 strides as Strided and reports the stride', () => {
    const c = new AccessClassifier();
    // Stride of +5 (fast-forward / thumbnail strip).
    const frames = Array.from({ length: 64 }, (_, i) => i * 5);
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Strided');
    expect(s.stride).toBe(5);
  });
});

describe('AccessClassifier loop', () => {
  it('detects a tight loop over [30, 60] and reports the range', () => {
    const c = new AccessClassifier();
    const frames: number[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 30; i <= 60; i++) frames.push(i);
    }
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Loop');
    expect(s.loopRange).toBeDefined();
    expect(s.loopRange![0]).toBeCloseTo(30, 0);
    expect(s.loopRange![1]).toBeCloseTo(60, 0);
  });
});

describe('AccessClassifier hotspots', () => {
  it('detects when a small set of frames dominates', () => {
    const c = new AccessClassifier();
    // 75% of pulls land on frames {0, 100, 200}; 25% on random others.
    const frames: number[] = [];
    const hot = [0, 100, 200];
    for (let i = 0; i < 64; i++) {
      if (i % 4 === 0) frames.push(Math.floor(Math.random() * 500) + 300);
      else frames.push(hot[i % 3]);
    }
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Hotspots');
    expect(s.hotFrames).toBeDefined();
    // The hot set must appear in the reported top frames (order may vary).
    for (const h of hot) {
      expect(s.hotFrames).toContain(h);
    }
  });
});

describe('AccessClassifier loop boundary (regression)', () => {
  it('does NOT flip to Scrub when sequential play loops back to start', () => {
    // The simplest playback: 250 frames, play 0..249, loop back to 0,
    // play again. The first wraparound puts ONE big negative stride in
    // the window — Scrub would otherwise grab it (≥2 long +1 bursts +
    // high variance), even though Loop hasn't seen enough cycles to win.
    const c = new AccessClassifier();
    const frames: number[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let i = 0; i < 250; i++) frames.push(i);
    }
    feed(c, frames.slice(0, 270));    // past the first wraparound
    expect(c.snapshot().mode).toBe('Sequential');
  });

  it('eventually transitions Sequential → Loop after enough cycles', () => {
    const c = new AccessClassifier();
    const frames: number[] = [];
    // Tight loop so we hit Loop's ≥3-cycle threshold within the ring.
    for (let cycle = 0; cycle < 8; cycle++) {
      for (let i = 0; i < 40; i++) frames.push(i);
    }
    feed(c, frames);
    expect(c.snapshot().mode).toBe('Loop');
  });
});

describe('AccessClassifier scrub', () => {
  it('detects high-variance jumps with brief sequential bursts', () => {
    const c = new AccessClassifier();
    // Pattern: 4-frame burst, big unpredictable jump, 4-frame burst, …
    // Mimics interactive timeline scrubbing. Important: bases drawn
    // from a deterministic LCG so reset magnitudes don't cluster —
    // otherwise the classifier (correctly) calls this a Loop.
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const frames: number[] = [];
    for (let cycle = 0; cycle < 16; cycle++) {
      const base = rand() % 5000;
      for (let k = 0; k < 4; k++) frames.push(base + k);
    }
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Scrub');
  });
});

describe('AccessClassifier random', () => {
  it('falls through to Random when no structure dominates', () => {
    const c = new AccessClassifier();
    // Deterministic uniform-ish over [0, 1000). LCG so the test is stable
    // — Math.random can occasionally cluster reset magnitudes by chance.
    let seed = 424242;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const frames = Array.from({ length: 96 }, () => rand() % 1000);
    feed(c, frames);
    const s = c.snapshot();
    expect(s.mode).toBe('Random');
  });
});

describe('AccessClassifier hysteresis', () => {
  it('does not flip mode on a single classifier run; requires two', () => {
    const c = new AccessClassifier();
    // 16 sequential → Sequential commits.
    feed(c, Array.from({ length: 16 }, (_, i) => i));
    expect(c.snapshot().mode).toBe('Sequential');

    // 32 reverse pulls. Classifier runs at pull 32 (mixed; no winner) and
    // again at pull 48 (Reverse becomes candidate, not yet committed).
    feed(c, Array.from({ length: 32 }, (_, i) => 16 - i), 16 * 33);
    expect(c.snapshot().mode).toBe('Sequential');   // still

    // 16 more reverse → classifier at pull 64; Reverse wins twice in a
    // row, commits.
    feed(c, Array.from({ length: 16 }, (_, i) => -16 - i), 48 * 33);
    expect(c.snapshot().mode).toBe('Reverse');
  });
});

describe('AccessClassifier reset', () => {
  it('returns to cold-start defaults', () => {
    const c = new AccessClassifier();
    feed(c, Array.from({ length: 64 }, (_, i) => i));
    c.reset();
    const s = c.snapshot();
    expect(s.mode).toBe('Sequential');
    expect(s.confidence).toBe(0);
  });
});
