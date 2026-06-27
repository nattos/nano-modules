import { describe, it, expect } from 'vitest';
import { decideCursorAction, clampPlaybackRate, clampSec, type CursorDecisionInput } from './playback-cursor';

const base: CursorDecisionInput = {
  curSec: 1.0, targetSec: 1.0, durationSec: 10, fps: 30, rate: 1, seeking: false,
};
// fps 30 → frame ≈ 0.0333, tol = 0.05, fwdCatchup = 0.5.

describe('decideCursorAction', () => {
  it('holds while a seek is in flight (whatever the target)', () => {
    expect(decideCursorAction({ ...base, seeking: true, targetSec: 5 }).kind).toBe('hold');
  });

  it('plays forward when the target is at or just ahead of us', () => {
    expect(decideCursorAction({ ...base, curSec: 1.0, targetSec: 1.0 }).kind).toBe('play'); // on us
    expect(decideCursorAction({ ...base, curSec: 1.0, targetSec: 1.1 }).kind).toBe('play'); // a bit ahead
    expect(decideCursorAction({ ...base, curSec: 1.0, targetSec: 1.45 }).kind).toBe('play'); // within catch-up
  });

  it('carries the (clamped) transport rate into the play action', () => {
    const a = decideCursorAction({ ...base, rate: 2 });
    expect(a).toEqual({ kind: 'play', rate: 2 });
    const fast = decideCursorAction({ ...base, rate: 1000 });
    expect(fast.kind === 'play' && fast.rate).toBe(16); // clamped
  });

  it('seeks when the target jumps far ahead (beyond the catch-up window)', () => {
    expect(decideCursorAction({ ...base, curSec: 1.0, targetSec: 3.0 }).kind).toBe('seek');
  });

  it('seeks when the target jumps backward (e.g. a loop wrap)', () => {
    const a = decideCursorAction({ ...base, curSec: 5.0, targetSec: 0.0 });
    expect(a).toEqual({ kind: 'seek', sec: 0 });
  });

  it('paused on-target holds; paused off-target seeks', () => {
    expect(decideCursorAction({ ...base, rate: 0, curSec: 2.0, targetSec: 2.0 }).kind).toBe('hold');
    expect(decideCursorAction({ ...base, rate: 0, curSec: 2.0, targetSec: 2.0 + 0.03 }).kind).toBe('hold'); // within a frame
    expect(decideCursorAction({ ...base, rate: 0, curSec: 2.0, targetSec: 4.0 }).kind).toBe('seek');
  });

  it('reverse never plays forward — it holds on-frame and seeks otherwise', () => {
    expect(decideCursorAction({ ...base, rate: -1, curSec: 2.0, targetSec: 1.99 }).kind).toBe('hold');
    expect(decideCursorAction({ ...base, rate: -1, curSec: 2.0, targetSec: 1.5 }).kind).toBe('seek');
  });

  it('with native loop, a wrap reads as on-target → play (no per-loop seek)', () => {
    // cur near the end, target just looped to the start: a full-file backward jump...
    const noLoop = decideCursorAction({ ...base, rate: 1, curSec: 9.99, targetSec: 0.02, durationSec: 10 });
    expect(noLoop.kind).toBe('seek'); // ...is a seek without native loop
    const looped = decideCursorAction({ ...base, rate: 1, curSec: 9.99, targetSec: 0.02, durationSec: 10, loopPeriodSec: 10 });
    expect(looped.kind).toBe('play'); // ...but the folded delta is ~0 with native loop
  });

  it('clamps the seek target inside the decodable range', () => {
    const a = decideCursorAction({ ...base, rate: 0, curSec: 0, targetSec: 999, durationSec: 10 });
    expect(a.kind).toBe('seek');
    if (a.kind === 'seek') expect(a.sec).toBeLessThan(10);
  });
});

describe('clampPlaybackRate', () => {
  it('keeps a sane window', () => {
    expect(clampPlaybackRate(1)).toBe(1);
    expect(clampPlaybackRate(0)).toBe(0.0625);
    expect(clampPlaybackRate(100)).toBe(16);
  });
});

describe('clampSec', () => {
  it('clamps into [0, duration)', () => {
    expect(clampSec(-5, 10, 1 / 30)).toBe(0);
    expect(clampSec(5, 10, 1 / 30)).toBe(5);
    expect(clampSec(20, 10, 1 / 30)).toBeLessThan(10);
  });
});
