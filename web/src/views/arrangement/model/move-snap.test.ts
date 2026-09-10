import { describe, it, expect } from 'vitest';
import { snapMoveStart, EDGE_MAGNET_PX } from './move-snap';

const PPB = 40; // px per beat → the magnet is EDGE_MAGNET_PX/40 = 0.25 beats

describe('snapMoveStart', () => {
  it('lands the ABSOLUTE start on the grid, not the delta', () => {
    // A clip that begins off-grid at 1.37 dragged ~3 beats right lands on 4,
    // not on 4.37 (which is what quantizing the delta gave).
    expect(snapMoveStart({ targetStart: 4.37, lengthBeat: 2, step: 1, pxPerBeat: PPB }))
      .toBeCloseTo(4);
    // ...and dragging it barely at all still pulls it onto the grid.
    expect(snapMoveStart({ targetStart: 1.4, lengthBeat: 2, step: 1, pxPerBeat: PPB }))
      .toBeCloseTo(1);
  });

  it('honours a fractional grid step', () => {
    expect(snapMoveStart({ targetStart: 4.3, lengthBeat: 1, step: 0.25, pxPerBeat: PPB }))
      .toBeCloseTo(4.25);
  });

  it('snaps the START snug against a neighbour clip END', () => {
    const edges = { clipEnds: [3.7], clipStarts: [] };
    // 3.8 is within the magnet of 3.7 and would otherwise round to 4.
    expect(snapMoveStart({ targetStart: 3.8, lengthBeat: 2, step: 1, pxPerBeat: PPB, edges }))
      .toBeCloseTo(3.7);
  });

  it('snaps the END snug against a neighbour clip START', () => {
    const edges = { clipEnds: [], clipStarts: [10.3] };
    // Length 2 ⇒ the start that puts the end on 10.3 is 8.3.
    expect(snapMoveStart({ targetStart: 8.2, lengthBeat: 2, step: 1, pxPerBeat: PPB, edges }))
      .toBeCloseTo(8.3);
  });

  it('leaves the grid in charge outside the magnet radius', () => {
    const edges = { clipEnds: [3.0], clipStarts: [] };
    // 3.6 is 0.6 beats (24px) from the edge — past the 10px magnet — so the
    // grid wins and it rounds to 4.
    expect(snapMoveStart({ targetStart: 3.6, lengthBeat: 2, step: 1, pxPerBeat: PPB, edges }))
      .toBeCloseTo(4);
  });

  it('picks the NEAREST candidate when several are in range', () => {
    const edges = { clipEnds: [7.9, 8.15], clipStarts: [] };
    expect(snapMoveStart({ targetStart: 8.1, lengthBeat: 1, step: 1, pxPerBeat: PPB, edges }))
      .toBeCloseTo(8.15);
  });

  it('scales the magnet with zoom (it is a px radius)', () => {
    const edges = { clipEnds: [3.7], clipStarts: [] };
    const at = (pxPerBeat: number) =>
      snapMoveStart({ targetStart: 3.8, lengthBeat: 2, step: 1, pxPerBeat, edges });
    // Zoomed in, 0.1 beats is far more than EDGE_MAGNET_PX px away → grid wins.
    expect(at(EDGE_MAGNET_PX * 20)).toBeCloseTo(4);
    // Zoomed out, it's well inside → snug.
    expect(at(EDGE_MAGNET_PX * 4)).toBeCloseTo(3.7);
  });

  it('never returns a negative start', () => {
    expect(snapMoveStart({ targetStart: -3, lengthBeat: 2, step: 1, pxPerBeat: PPB })).toBe(0);
    expect(snapMoveStart({
      targetStart: 0.05, lengthBeat: 2, step: 1, pxPerBeat: PPB,
      edges: { clipEnds: [-0.5], clipStarts: [] },
    })).toBe(0);
  });
});
