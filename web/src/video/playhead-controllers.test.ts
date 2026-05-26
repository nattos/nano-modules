import { describe, it, expect } from 'vitest';
import { Playhead, defaultParams } from './playhead-controllers';

const FRAME_COUNT = 250;

describe('Playhead loop', () => {
  it('advances 1 frame per (1000/fps) ms at speed=1', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 99, fps: 30, speed: 1 },
      FRAME_COUNT,
    );
    p.start(0);
    expect(p.frameAt(0)).toBe(0);
    expect(p.frameAt(1000 / 30)).toBe(1);          // 1 frame later
    expect(p.frameAt((1000 / 30) * 10)).toBe(10);  // 10 frames later
  });

  it('wraps when reaching outFrame', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 9, fps: 30, speed: 1 },
      FRAME_COUNT,
    );
    p.start(0);
    // 10 frames per cycle → at frame 11 we should be at index 1.
    expect(p.frameAt((1000 / 30) * 11)).toBe(1);
  });

  it('reverse-loop counts down from outFrame', () => {
    const p = new Playhead(
      { kind: 'reverse-loop', inFrame: 0, outFrame: 9, fps: 30, speed: 1 },
      FRAME_COUNT,
    );
    p.start(0);
    expect(p.frameAt(0)).toBe(9);
    expect(p.frameAt(1000 / 30)).toBe(8);
  });
});

describe('Playhead pingpong', () => {
  it('reverses direction at outFrame', () => {
    const p = new Playhead(
      { kind: 'pingpong', inFrame: 0, outFrame: 4, fps: 30, speed: 1 },
      FRAME_COUNT,
    );
    p.start(0);
    const out: number[] = [];
    for (let i = 0; i < 10; i++) out.push(p.frameAt((1000 / 30) * i));
    // 5-frame range, ping-pong period 2*(5-1)=8 → 0,1,2,3,4,3,2,1,0,1
    expect(out).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0, 1]);
  });
});

describe('Playhead random-jumps', () => {
  it('jumps to a new anchor every jumpEveryMs and plays forward between', () => {
    // Deterministic RNG so we can predict the jump targets.
    let seed = 1;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const p = new Playhead(
      {
        kind: 'random-jumps',
        inFrame: 0, outFrame: 99, fps: 30, speed: 1,
        jumpEveryMs: 1000,
      },
      FRAME_COUNT,
      rng,
    );
    p.start(0);
    const t0Frame = p.frameAt(0);
    const tHalfSec = p.frameAt(500);          // still on the same anchor
    expect(tHalfSec).toBe(t0Frame + 15);      // ~15 frames after start of anchor
    const t1Sec = p.frameAt(1000);            // jump triggers → new anchor
    expect(t1Sec).not.toBe(tHalfSec + 15);    // discontinuity from the jump
  });
});

describe('Playhead never stops at the end', () => {
  // Every moving mode must keep moving past outFrame — loop/reverse-loop
  // wrap, ping-pong reflects, random-jumps wraps between jumps.
  it('loop keeps moving after passing outFrame (does not stick)', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 9, fps: 30, speed: 1 },
      FRAME_COUNT,
    );
    p.start(0);
    // Advance well past the end, then a tiny bit more — frame must change.
    const a = p.frameAt(1000);          // 30 frames played → wrapped
    const b = p.frameAt(1000 + 1000 / 30);
    expect(a).toBeLessThanOrEqual(9);   // stayed in range
    expect(b).not.toBe(a);              // still moving, didn't stick
  });

  it('random-jumps wraps between jumps rather than sticking at outFrame', () => {
    const p = new Playhead(
      { kind: 'random-jumps', inFrame: 0, outFrame: 9, fps: 30, speed: 1, jumpEveryMs: 100000 },
      FRAME_COUNT,
    );
    p.start(0);
    // No jump within the window (huge interval). Forward play must wrap.
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) seen.add(p.frameAt((1000 / 30) * i));
    // Over 60 frames of a 10-frame range, it must have wrapped → visited
    // low frames again after reaching the top.
    expect(seen.has(0)).toBe(true);
    expect(Math.max(...seen)).toBeLessThanOrEqual(9);
  });
});

describe('Playhead hold', () => {
  it('returns the same frame regardless of time', () => {
    const p = new Playhead(
      { kind: 'hold', inFrame: 0, outFrame: 99, fps: 30, speed: 1, holdFrame: 42 },
      FRAME_COUNT,
    );
    p.start(0);
    expect(p.frameAt(0)).toBe(42);
    expect(p.frameAt(123456)).toBe(42);
  });
});

describe('Playhead integrates rate changes (no leap)', () => {
  // EFFECTS_STYLE_GUIDE §2.1. Position is state; the rate only scales the
  // per-step advance. Changing fps/speed mid-stream moves the head faster
  // or slower from that point — it never relocates it.

  it('speed change does not retroactively re-multiply elapsed time', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 999, fps: 30, speed: 1 },
      1000,
    );
    p.start(0);
    expect(p.frameAt(1000)).toBe(30);    // 1 s at 30 fps · speed 1 = 30
    p.params.speed = 2;                  // double speed mid-stream
    // The OLD shape was `framesPlayed = (now − start) · fps · speed`, so
    // flipping speed re-multiplied past time → 2 s · 30 · 2 = 120, an
    // instant jump. Position-state just advances from 30 at the new rate.
    expect(p.frameAt(2000)).toBe(90);    // 30 + 1 s · 30 · 2 = 90
    expect(p.frameAt(3000)).toBe(150);   // +1 s @ new rate = +60
  });

  it('fps change does not retroactively re-multiply elapsed time', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 999, fps: 30, speed: 1 },
      1000,
    );
    p.start(0);
    expect(p.frameAt(1000)).toBe(30);
    p.params.fps = 60;
    expect(p.frameAt(2000)).toBe(90);    // 30 + 1 s · 60 fps = 90
    expect(p.frameAt(3000)).toBe(150);
  });

  it('reverse speed accumulates in the negative direction without snapping past values', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 99, fps: 30, speed: 1 },
      100,
    );
    p.start(0);
    expect(p.frameAt(1000)).toBe(30);
    p.params.speed = -1;                 // play backwards now
    expect(p.frameAt(2000)).toBe(0);     // 30 − 1 s · 30 = 0
    expect(p.frameAt(3000)).toBe(70);    // −1 s more → −30, mod 100 → 70
  });
});

describe('Playhead range changes (in/out) do not jump unless forced', () => {
  it('narrowing the range around the current position keeps the head put', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 249, fps: 30, speed: 1 },
      250,
    );
    p.start(0);
    // Play well past the first wrap so we're deep into a cycle.
    const before = p.frameAt(300 * (1000 / 30));   // 300 frames → wrapped → frame 50
    expect(before).toBe(50);
    // Narrow to a range that still contains frame 50.
    p.params.inFrame = 40;
    p.params.outFrame = 60;
    // A negligible time step — the head must stay at 50 (no remap jump).
    const after = p.frameAt(300 * (1000 / 30) + 0.001);
    expect(after).toBe(50);
  });

  it('forces the head into range only when the new range excludes it', () => {
    const p = new Playhead(
      { kind: 'loop', inFrame: 0, outFrame: 249, fps: 30, speed: 1 },
      250,
    );
    p.start(0);
    expect(p.frameAt(300 * (1000 / 30))).toBe(50);   // at frame 50
    // Narrow to [0, 30] — frame 50 is now outside, must be forced in.
    p.params.inFrame = 0;
    p.params.outFrame = 30;
    const after = p.frameAt(300 * (1000 / 30) + 0.001);
    expect(after).toBeLessThanOrEqual(30);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it('ping-pong keeps its position and direction across an in-range edit', () => {
    const p = new Playhead(
      { kind: 'pingpong', inFrame: 0, outFrame: 99, fps: 30, speed: 1 },
      100,
    );
    p.start(0);
    // Drive forward ~40 frames.
    const before = p.frameAt(40 * (1000 / 30));
    expect(before).toBe(40);
    // Tighten the range to [20, 80] — 40 is inside.
    p.params.inFrame = 20;
    p.params.outFrame = 80;
    const after = p.frameAt(40 * (1000 / 30) + 0.001);
    expect(after).toBe(40);          // no jump
  });
});

describe('defaultParams', () => {
  it('produces a valid params object for every kind', () => {
    for (const kind of ['loop', 'reverse-loop', 'pingpong', 'random-jumps', 'hold'] as const) {
      const p = defaultParams(kind, 100);
      expect(p.kind).toBe(kind);
      expect(p.inFrame).toBe(0);
      expect(p.outFrame).toBe(99);
    }
  });
});
