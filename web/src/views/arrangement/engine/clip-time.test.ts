import { describe, it, expect } from 'vitest';
import { clipSourceTimeAt, clipSourceFrameAt, type ClipTimeCtx } from './clip-time';
import type { ClipLoopConfig } from '../model/composition';

/**
 * The beat→source-time mapper. Warp enters only through `secondsAt`; tests use a
 * plain `beat·secPerBeat` clock (un-warped) plus one non-linear clock for the warp
 * case. A clip starts at beat 0 unless noted, over a 10s source.
 */
const linear = (bpm: number) => (beat: number) => beat * (60 / bpm);
const ctx = (over: Partial<ClipTimeCtx> = {}): ClipTimeCtx => ({
  startBeat: 0,
  lengthBeat: 16,
  videoDurSec: 10,
  secondsAt: linear(120), // 0.5 s/beat
  ...over,
});
const loop = (over: Partial<ClipLoopConfig>): ClipLoopConfig => ({
  mode: 'time',
  startSec: 0,
  speed: 1,
  direction: 'forward',
  ...over,
});

describe('clipSourceTimeAt — one-shot', () => {
  it('plays once from startSec at the real-time rate (speed 1)', () => {
    const l = loop({ mode: 'one-shot', startSec: 0 });
    expect(clipSourceTimeAt(l, ctx(), 0)).toBeCloseTo(0);
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(1); // 2 beats · 0.5 s/beat
    expect(clipSourceTimeAt(l, ctx(), 4)).toBeCloseTo(2);
  });

  it('applies the speed scale factor', () => {
    const l = loop({ mode: 'one-shot', startSec: 0, speed: 2 });
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(2); // 2× faster into the source
  });

  it('never loops — runs off the file end ⇒ transparent', () => {
    const l = loop({ mode: 'one-shot', startSec: 9 });
    expect(clipSourceTimeAt(l, ctx(), 1)).toBeCloseTo(9.5); // vt = 9 + 0.5, still in [0,10)
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeNull(); // vt = 9 + 1 = 10 === videoDur ⇒ off end
    expect(clipSourceTimeAt(l, ctx(), 8)).toBeNull(); // well past the end
  });

  it('negative startSec ⇒ transparent before the source start', () => {
    const l = loop({ mode: 'one-shot', startSec: -1 });
    expect(clipSourceTimeAt(l, ctx(), 0)).toBeNull(); // vt = -1
    expect(clipSourceTimeAt(l, ctx(), 1)).toBeNull(); // vt = -0.5
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(0); // vt = 0, the file start
    expect(clipSourceTimeAt(l, ctx(), 4)!).toBeCloseTo(1);
  });

  it('reverse counts down from startSec', () => {
    const l = loop({ mode: 'one-shot', startSec: 5, direction: 'reverse' });
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(4); // 5 - 1
    expect(clipSourceTimeAt(l, ctx(), 10)).toBeCloseTo(0); // 5 - 5
    expect(clipSourceTimeAt(l, ctx(), 10.001)).toBeNull(); // off the start
  });
});

describe('clipSourceFrameAt — frame alignment', () => {
  it('shows each source frame an exact whole number of times when rates align', () => {
    // 30 fps source, speed 1, sampled at 60 fps (render). secondsAt = identity (bpm 60),
    // so 1 render step = 1/60 s; source advances 0.5 frame/step ⇒ every frame twice.
    const l = loop({ mode: 'one-shot', startSec: 0 });
    const c = ctx({ secondsAt: linear(60), videoDurSec: 100 });
    const counts = new Map<number, number>();
    for (let i = 0; i < 120; i++) {
      const beat = i / 60 + 1e-7; // nudge off exact boundaries (FP)
      const f = clipSourceFrameAt(l, c, beat, 30, 3000)!;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    // Frames 0..59 each appear exactly twice.
    for (let f = 0; f < 60; f++) expect(counts.get(f)).toBe(2);
  });

  it('clamps to [0, frameCount-1] and passes null through', () => {
    const l = loop({ mode: 'one-shot', startSec: 0 });
    expect(clipSourceFrameAt(l, ctx(), 0, 30, 300)).toBe(0);
    // transparent ⇒ null frame
    const off = loop({ mode: 'one-shot', startSec: -1 });
    expect(clipSourceFrameAt(off, ctx(), 0, 30, 300)).toBeNull();
  });
});

describe('clipSourceTimeAt — time (loops with BPM + length)', () => {
  it('loops within [startSec, endSec]', () => {
    const l = loop({ mode: 'time', startSec: 2, endSec: 4 }); // loopLen 2
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(3); // elapsed 1 → 2 + 1
    expect(clipSourceTimeAt(l, ctx(), 4)).toBeCloseTo(2); // elapsed 2 → wrapped to start
    expect(clipSourceTimeAt(l, ctx(), 6)).toBeCloseTo(3); // elapsed 3 → 2 + (3 mod 2)
  });

  it('loop count scales with BPM (more loops at slower tempo)', () => {
    const l = loop({ mode: 'time', startSec: 0, endSec: 1 }); // loopLen 1
    // At beat 8: slow clock (bpm 60 → 8 s elapsed → 8 loops) vs fast (bpm 240 → 2 s → 2 loops).
    const loopsAt = (bpm: number) => {
      const c = ctx({ secondsAt: linear(bpm) });
      return Math.floor((c.secondsAt(8) - c.secondsAt(0)) / 1);
    };
    expect(loopsAt(60)).toBe(8);
    expect(loopsAt(240)).toBe(2);
    // The mapped phase is identical mod the loop regardless (always within the slice).
    expect(clipSourceTimeAt(l, ctx({ secondsAt: linear(60) }), 8)).toBeCloseTo(0);
  });

  it('ping-pong reflects at the slice ends', () => {
    const l = loop({ mode: 'time', startSec: 0, endSec: 2, pingpong: true });
    // consumed = elapsed: 1→1, 3→ reflect(3,2)=1, 2.5→ reflect=1.5
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(1); // elapsed 1
    expect(clipSourceTimeAt(l, ctx(), 6)).toBeCloseTo(1); // elapsed 3 → 4-3
    expect(clipSourceTimeAt(l, ctx(), 5)).toBeCloseTo(1.5); // elapsed 2.5 → 4-2.5
  });

  it('reverse plays the slice backward (wrapping)', () => {
    const l = loop({ mode: 'time', startSec: 0, endSec: 2, direction: 'reverse' });
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(1); // consumed -1 → wrap → 1
  });
});

describe('clipSourceTimeAt — beat-sync (loops locked to beats, BPM-independent)', () => {
  it('one loop spans syncBeats beats, independent of BPM', () => {
    const l = loop({ mode: 'beat-sync', startSec: 0, endSec: 8, syncBeats: 4 });
    // localBeat 2 → phase 0.5 → vt 4; localBeat 4 → wrapped to 0.
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(4);
    expect(clipSourceTimeAt(l, ctx(), 4)).toBeCloseTo(0);
    expect(clipSourceTimeAt(l, ctx(), 6)).toBeCloseTo(4);
    // Same beat, very different clocks ⇒ identical source time (BPM doesn't matter).
    const slow = clipSourceTimeAt(l, ctx({ secondsAt: linear(40) }), 3);
    const fast = clipSourceTimeAt(l, ctx({ secondsAt: linear(200) }), 3);
    expect(slow).toBeCloseTo(fast!);
    expect(slow).toBeCloseTo(6); // localBeat 3 → 0.75 · 8
  });

  it('syncUseBpm derives the beat span from a natural BPM + the slice seconds', () => {
    // loopLen 2 s at 120 bpm ⇒ 4 beats — matches syncBeats: 4.
    const bpmMode = loop({ mode: 'beat-sync', startSec: 0, endSec: 2, syncUseBpm: true, syncBpm: 120 });
    const beatsMode = loop({ mode: 'beat-sync', startSec: 0, endSec: 2, syncBeats: 4 });
    for (const beat of [1, 2, 3, 5]) {
      expect(clipSourceTimeAt(bpmMode, ctx(), beat)).toBeCloseTo(clipSourceTimeAt(beatsMode, ctx(), beat)!);
    }
  });

  it('ping-pong + reverse work in the beat domain', () => {
    const pp = loop({ mode: 'beat-sync', startSec: 0, endSec: 4, syncBeats: 4, pingpong: true });
    expect(clipSourceTimeAt(pp, ctx(), 2)).toBeCloseTo(2); // localBeat 2 → mid, forward
    expect(clipSourceTimeAt(pp, ctx(), 6)).toBeCloseTo(2); // reflect: fold(6,4,pp)=2 → 0.5·4
    const rev = loop({ mode: 'beat-sync', startSec: 0, endSec: 4, syncBeats: 4, direction: 'reverse' });
    expect(clipSourceTimeAt(rev, ctx(), 1)).toBeCloseTo(3); // fold(-1,4)=3 → 0.75·4
  });
});

describe('clipSourceTimeAt — playStartSec (the loop "Start" marker)', () => {
  it('within the loop: begins partway through, then wraps to the loop start', () => {
    // slice [0,4], start playback at 3s → 3 → 4(wrap to 0) → 1 ...
    const l = loop({ mode: 'time', startSec: 0, endSec: 4, playStartSec: 3 });
    expect(clipSourceTimeAt(l, ctx(), 0)).toBeCloseTo(3); // left edge plays 3s
    expect(clipSourceTimeAt(l, ctx(), 1)).toBeCloseTo(3.5); // +0.5s, still first pass
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(0); // +1s → 4 = loopEnd → wraps to 0
    expect(clipSourceTimeAt(l, ctx(), 4)).toBeCloseTo(1); // elapsed 2s → 3+2=5 → wrapped: 0 + (5-4) = 1
  });

  it('before the loop start: a pre-roll plays once, then the loop kicks in', () => {
    // slice [4,6], play-start 2s (before loopStart). Pre-roll 2→4 then loop [4,6].
    const l = loop({ mode: 'time', startSec: 4, endSec: 6, playStartSec: 2 });
    expect(clipSourceTimeAt(l, ctx(), 0)).toBeCloseTo(2); // left edge: pre-roll
    expect(clipSourceTimeAt(l, ctx(), 4)).toBeCloseTo(4); // elapsed 2s → 2+2=4 = loopStart
    expect(clipSourceTimeAt(l, ctx(), 8)).toBeCloseTo(4); // elapsed 4s → 2+4=6=loopEnd → wrap → 4
    expect(clipSourceTimeAt(l, ctx(), 6)).toBeCloseTo(5); // elapsed 3s → 2+3=5 (in loop)
  });

  it('a pre-roll that runs off the file start is transparent until the source begins', () => {
    const l = loop({ mode: 'time', startSec: 2, endSec: 4, playStartSec: -1 });
    expect(clipSourceTimeAt(l, ctx(), 0)).toBeNull(); // play-start -1 < 0 ⇒ before the file
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(0); // elapsed 1s → -1+1 = 0 (file start)
  });

  it('beat-sync respects the play-start anchor too', () => {
    const l = loop({ mode: 'beat-sync', startSec: 0, endSec: 8, syncBeats: 4, playStartSec: 4 });
    // consumed/beat = loopLen/videoBeats = 2; left edge plays 4s.
    expect(clipSourceTimeAt(l, ctx(), 0)).toBeCloseTo(4);
    expect(clipSourceTimeAt(l, ctx(), 2)).toBeCloseTo(0); // 4 + (2·2)=8=loopEnd → wrap → 0
  });
});

describe('clipSourceTimeAt — warp', () => {
  it('redistributes one-shot/time but leaves beat-sync beat-locked', () => {
    // A non-linear clock that spends MORE real time in the first half (warp spread).
    const warped = (beat: number) => 0.5 * (beat + 0.1 * beat * beat);
    const cw = ctx({ secondsAt: warped, videoDurSec: 100 });
    const cl = ctx({ secondsAt: linear(120), videoDurSec: 100 });

    const one = loop({ mode: 'one-shot', startSec: 0 });
    // At beat 4 the warped clock has advanced further into the source than linear.
    expect(clipSourceTimeAt(one, cw, 4)!).toBeGreaterThan(clipSourceTimeAt(one, cl, 4)!);

    const bs = loop({ mode: 'beat-sync', startSec: 0, endSec: 8, syncBeats: 4 });
    // beat-sync ignores the clock — identical source time under warp.
    expect(clipSourceTimeAt(bs, cw, 3)).toBeCloseTo(clipSourceTimeAt(bs, cl, 3)!);
  });
});

describe('clipSourceTimeAt — random (deterministic seeded noise)', () => {
  const rnd = (over: Partial<ClipLoopConfig> = {}) =>
    loop({ mode: 'random', startSec: 2, endSec: 8, ...over });

  it('stays within the slice [startSec, endSec] for all beats', () => {
    const l = rnd();
    for (let b = 0; b < 64; b += 0.37) {
      const vt = clipSourceTimeAt(l, ctx({ seed: 0.3 }), b)!;
      expect(vt).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(vt).toBeLessThanOrEqual(8 + 1e-9);
    }
  });

  it('is deterministic — same beat + seed ⇒ same source time (reproducible scrub)', () => {
    const l = rnd();
    expect(clipSourceTimeAt(l, ctx({ seed: 0.42 }), 5.5)).toBe(
      clipSourceTimeAt(l, ctx({ seed: 0.42 }), 5.5),
    );
  });

  it('decorrelates by seed — different clips wander differently', () => {
    const l = rnd();
    const a = clipSourceTimeAt(l, ctx({ seed: 0.1 }), 5.5)!;
    const b = clipSourceTimeAt(l, ctx({ seed: 0.9 }), 5.5)!;
    expect(Math.abs(a - b)).toBeGreaterThan(1e-3);
  });

  it('is continuous — a tiny beat step makes a tiny source-time step (smooth)', () => {
    const l = rnd({ speed: 1 });
    const a = clipSourceTimeAt(l, ctx({ seed: 0.5 }), 10)!;
    const b = clipSourceTimeAt(l, ctx({ seed: 0.5 }), 10.001)!;
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });

  it('evolution rate follows the dwell (shorter dwell ⇒ faster wander)', () => {
    const slow = clipSourceTimeAt(rnd({ dwell: 8 }), ctx({ seed: 0.5 }), 7)!;
    const fast = clipSourceTimeAt(rnd({ dwell: 0.5 }), ctx({ seed: 0.5 }), 7)!;
    expect(slow).not.toBeCloseTo(fast); // different phase reached by the same beat
  });

  it('frame selection clamps into the file', () => {
    const f = clipSourceFrameAt(rnd(), { ...ctx({ seed: 0.5 }) }, 9.3, 30, 300);
    expect(f).not.toBeNull();
    expect(f!).toBeGreaterThanOrEqual(0);
    expect(f!).toBeLessThanOrEqual(299);
  });
});
