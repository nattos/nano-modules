import { describe, it, expect } from 'vitest';
import { TransportController, type TransportState } from './transport-clock';
import { emptyComposition } from '../model/composition';

/**
 * Loop wrap behaviour: a playhead crossing loopEnd from inside wraps; a playhead
 * that STARTS outside the loop keeps playing (never yanked back).
 */
function makeState(positionBeat: number): TransportState {
  return {
    playing: true,
    positionBeat,
    loopEnabled: true,
    loopStartBeat: 0,
    loopEndBeat: 8,
    composition: emptyComposition(), // 120 bpm, no warp → 1 beat = 0.5s
    setPosition(b: number) { this.positionBeat = b; },
  };
}

describe('transport loop wrap', () => {
  it('wraps when crossing loopEnd from inside the loop', () => {
    const s = makeState(7.5);
    const t = new TransportController();
    t.advance(s, 1.0); // 1s = 2 beats → 7.5 → 9.5, crosses 8 → wraps near 0
    expect(s.positionBeat).toBeLessThan(8);
    expect(s.positionBeat).toBeGreaterThanOrEqual(0);
  });

  it('keeps playing past loopEnd when it started OUTSIDE the loop', () => {
    const s = makeState(40); // already well past loopEnd (8)
    const t = new TransportController();
    t.advance(s, 1.0);
    expect(s.positionBeat).toBeGreaterThan(40); // advanced, not wrapped to ~0
  });
});
