import { describe, it, expect } from 'vitest';
import { TransportController, type TransportState } from './transport-clock';
import { emptyComposition, type Composition, type Clip } from '../model/composition';
import { makeWarpClock } from './warp-clock';

/** A minimal mutable TransportState backed by a plain object. */
function makeState(comp: Composition, over: Partial<TransportState> = {}): TransportState {
  return {
    playing: true,
    positionBeat: 0,
    loopEnabled: false,
    loopStartBeat: 0,
    loopEndBeat: 32,
    composition: comp,
    setPosition(beat: number) {
      this.positionBeat = Math.max(0, beat);
    },
    ...over,
  };
}

function warpedClip(): Clip {
  return {
    id: 'c1',
    name: 'warp',
    startBeat: 0,
    lengthBeat: 32,
    kind: 'effect',
    sketch: { devices: [] },
    loop: { mode: 'hold' },
    automation: [],
    exports: [],
    warps: [
      { id: 'w1', sourceDeviceId: 'd', waveform: 'sine', amplitude: 0.5, periodBeats: 16, phase: 0 },
    ],
  };
}

describe('TransportController', () => {
  it('advances at the flat beat rate with no warp', () => {
    const comp = emptyComposition(); // bpm 120 → 0.5 s/beat, no warps
    const tc = new TransportController();
    const s = makeState(comp);
    tc.advance(s, 0.5); // half a second
    expect(s.positionBeat).toBeCloseTo(1, 5); // exactly one beat at 120 BPM
    tc.advance(s, 1.0);
    expect(s.positionBeat).toBeCloseTo(3, 5);
  });

  it('does nothing while stopped', () => {
    const comp = emptyComposition();
    const tc = new TransportController();
    const s = makeState(comp, { playing: false, positionBeat: 5 });
    tc.advance(s, 1.0);
    expect(s.positionBeat).toBe(5);
  });

  it('re-anchors when the playhead is scrubbed externally', () => {
    const comp = emptyComposition();
    const tc = new TransportController();
    const s = makeState(comp);
    tc.advance(s, 0.5); // → beat 1
    // External scrub during playback.
    s.positionBeat = 10;
    tc.advance(s, 0.5); // should continue from 10, not from 1
    expect(s.positionBeat).toBeCloseTo(11, 5);
  });

  it('wraps at the loop end back near the loop start', () => {
    const comp = emptyComposition();
    const tc = new TransportController();
    const s = makeState(comp, {
      loopEnabled: true,
      loopStartBeat: 4,
      loopEndBeat: 8,
      positionBeat: 7.5,
    });
    tc.advance(s, 0.5); // +1 beat → 8.5, past loopEnd 8 → wrap to ~4.5
    expect(s.positionBeat).toBeGreaterThanOrEqual(4);
    expect(s.positionBeat).toBeLessThan(8);
    expect(s.positionBeat).toBeCloseTo(4.5, 5);
  });

  it('advances at the warped local rate (matches localSecondsPerBeat)', () => {
    const comp = emptyComposition();
    comp.tracks.push({
      id: 't1', name: 'T', kind: 'track', parentId: null,
      sketch: { devices: [] }, automation: [], clips: [warpedClip()],
    });
    const clock = makeWarpClock(comp);
    const tc = new TransportController();

    // Pick a beat inside the warped region and step a tiny dt from there.
    const startBeat = 4;
    const s = makeState(comp, { positionBeat: startBeat });
    const dt = 0.01;
    tc.advance(s, dt);
    const dBeat = s.positionBeat - startBeat;

    // dBeat ≈ dt / (local seconds-per-beat at startBeat).
    const expected = dt / clock.localSecondsPerBeat(startBeat);
    expect(dBeat).toBeCloseTo(expected, 3);

    // And it must differ from the flat rate (warp is actually doing something).
    const flat = dt * (comp.meta.baseBPM / 60);
    expect(Math.abs(dBeat - flat)).toBeGreaterThan(1e-4);
  });
});
