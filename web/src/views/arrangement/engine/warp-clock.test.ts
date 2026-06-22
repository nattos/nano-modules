import { describe, it, expect } from 'vitest';
import { emptyComposition, type Composition } from '../model/composition';
import { makeWarpClock, precomputeWarp } from './warp-clock';

function compAt(bpm: number): Composition {
  const c = emptyComposition();
  c.meta.baseBPM = bpm;
  c.tracks.push({
    id: 't', name: 'T', kind: 'track', parentId: null,
    sketch: { devices: [] }, automation: [], clips: [],
  });
  return c;
}

/** A sine warp (amp 0.4, period 8 beats) over the clip [0,16]. */
function warpedComp(bpm = 120): Composition {
  const c = compAt(bpm);
  c.tracks[0].clips.push({
    id: 'c', name: 'C', startBeat: 0, lengthBeat: 16, kind: 'effect',
    sketch: { devices: [] }, loop: { mode: 'hold' }, automation: [], exports: [],
    warps: [{ id: 'w', sourceDeviceId: 'd', waveform: 'sine', amplitude: 0.4, periodBeats: 8, phase: 0 }],
  });
  return c;
}

describe('WarpClock', () => {
  it('is linear under no warp (seconds = beats × spb, exact inverse)', () => {
    const clock = makeWarpClock(compAt(120)); // spb = 0.5
    expect(clock.secondsPerBeat).toBeCloseTo(0.5, 9);
    for (const b of [0, 1, 4, 13.5, 32]) {
      expect(clock.secondsAt(b)).toBeCloseTo(b * 0.5, 6);
      expect(clock.beatAtSeconds(b * 0.5)).toBeCloseTo(b, 4);
    }
  });

  it('seconds increase monotonically and round-trip under warp', () => {
    const clock = makeWarpClock(warpedComp());
    let prev = -1;
    for (let b = 0; b <= 16; b += 1) {
      const s = clock.secondsAt(b);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
    for (const b of [1.5, 3, 5, 7, 10, 14]) {
      expect(clock.beatAtSeconds(clock.secondsAt(b))).toBeCloseTo(b, 2);
    }
  });

  it('redistributes time: spreads (slower) where m>1, clumps (faster) where m<1', () => {
    const clock = makeWarpClock(warpedComp()); // spb 0.5
    // beat 2: sine local phase 0.25 → +1 → m=1.4 → slower (more s/beat)
    expect(clock.localSecondsPerBeat(2)).toBeGreaterThan(0.5);
    // beat 6: sine local phase 0.75 → -1 → m=0.6 → faster (fewer s/beat)
    expect(clock.localSecondsPerBeat(6)).toBeLessThan(0.5);
  });

  it('preserves overall duration (warp averages out over whole periods)', () => {
    const clock = makeWarpClock(warpedComp()); // 2 full periods across [0,16]
    // The warp segment is [0,16]; beyond it tempo is neutral. Total stays spb×beats.
    expect(clock.secondsAt(16)).toBeCloseTo(16 * 0.5, 1);
    expect(clock.durationSeconds).toBeCloseTo(clock.curve.totalBeats * 0.5, 1);
  });

  it('is deterministic (same composition → identical curve)', () => {
    const a = makeWarpClock(warpedComp());
    const b = makeWarpClock(warpedComp());
    for (let beat = 0; beat <= 16; beat += 0.5) {
      expect(a.secondsAt(beat)).toBe(b.secondsAt(beat));
    }
  });

  it('precomputeWarp resolves any beat offline without a playhead', () => {
    const curve = precomputeWarp(warpedComp());
    // Arbitrary forward + inverse lookups, no stepping required.
    const u = curve.unitsAt(11.3);
    expect(Number.isFinite(u)).toBe(true);
    expect(curve.beatAt(u)).toBeCloseTo(11.3, 2);
  });
});
