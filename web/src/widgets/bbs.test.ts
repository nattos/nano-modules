import { describe, it, expect } from 'vitest';
import { beatsToBBS, bbsToBeats, formatBBS, parseBBS } from './bbs';

describe('bbs conversions', () => {
  it('decomposes beats into 1-based bar.beat.sixteenth (4/4, 4 six/beat)', () => {
    expect(beatsToBBS(0, 4, 4)).toEqual({ bar: 1, beat: 1, six: 1 });
    expect(beatsToBBS(1, 4, 4)).toEqual({ bar: 1, beat: 2, six: 1 });
    expect(beatsToBBS(4, 4, 4)).toEqual({ bar: 2, beat: 1, six: 1 });
    // 5 bars, 2 beats, 1 sixteenth = 4*4 + 1 = 17 beats.
    expect(beatsToBBS(17, 4, 4)).toEqual({ bar: 5, beat: 2, six: 1 });
    // A sixteenth is 1/4 beat.
    expect(beatsToBBS(0.25, 4, 4)).toEqual({ bar: 1, beat: 1, six: 2 });
    expect(beatsToBBS(0.75, 4, 4)).toEqual({ bar: 1, beat: 1, six: 4 });
  });

  it('round-trips beats ⇄ BBS on the sixteenth grid', () => {
    for (const beats of [0, 0.25, 1, 3.5, 17, 17.75, 42.5]) {
      const bbs = beatsToBBS(beats, 4, 4);
      expect(bbsToBeats(bbs, 4, 4)).toBeCloseTo(beats, 9);
    }
  });

  it('honours a non-4 time signature', () => {
    // 3/4: a bar is 3 beats.
    expect(beatsToBBS(3, 3, 4)).toEqual({ bar: 2, beat: 1, six: 1 });
    expect(bbsToBeats({ bar: 2, beat: 1, six: 1 }, 3, 4)).toBe(3);
  });

  it('bbsToBeats carries out-of-range components linearly', () => {
    // beat 6 in 4/4 rolls forward: (6-1) = 5 beats into bar 1 ⇒ bar 2, beat 2.
    const beats = bbsToBeats({ bar: 1, beat: 6, six: 1 }, 4, 4);
    expect(beats).toBe(5);
    expect(beatsToBBS(beats, 4, 4)).toEqual({ bar: 2, beat: 2, six: 1 });
  });

  it('formats and tolerantly parses', () => {
    expect(formatBBS({ bar: 5, beat: 2, six: 1 })).toBe('5.2.1');
    expect(parseBBS('5.2.1')).toEqual({ bar: 5, beat: 2, six: 1 });
    expect(parseBBS('5.2')).toEqual({ bar: 5, beat: 2, six: 1 }); // trailing default 1
    expect(parseBBS('5')).toEqual({ bar: 5, beat: 1, six: 1 });
    expect(parseBBS('  7 . 3 ')).toEqual({ bar: 7, beat: 3, six: 1 });
    expect(parseBBS('')).toBeNull();
    expect(parseBBS('abc')).toBeNull();
    // Lower-bounded at 1.
    expect(parseBBS('0.0.0')).toEqual({ bar: 1, beat: 1, six: 1 });
  });
});
