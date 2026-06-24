import { describe, it, expect, vi, afterEach } from 'vitest';
import { observable } from 'mobx';
import { DocHistory } from './history';

/**
 * A continuous pointer drag must coalesce into ONE undo entry no matter how long
 * the pointer dwells between frames — otherwise the gesture's base strands
 * mid-drag (the "can't move the clip back / destructive split on dwell" bug).
 */
afterEach(() => vi.restoreAllMocks());

function makeDoc() {
  const doc = observable({ x: 0 });
  return { doc, h: new DocHistory<{ x: number }>(() => doc) };
}

describe('DocHistory drag gesture', () => {
  it('folds dwelling drag steps into ONE undo entry (no time-window split)', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { doc, h } = makeDoc();
    h.beginGesture();
    h.record('move', (d) => { d.x = 1; }, 'm'); now += 2000; // dwell well past 500ms
    h.record('move', (d) => { d.x = 2; }, 'm'); now += 2000;
    h.record('move', (d) => { d.x = 3; }, 'm');
    h.endGesture();
    expect(doc.x).toBe(3);
    h.undo(); // a single undo reverts the WHOLE drag back to the pre-gesture base
    expect(doc.x).toBe(0);
    expect(h.canUndo).toBe(false);
  });

  it('without a gesture, a dwell past the window splits into separate entries', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { doc, h } = makeDoc();
    h.record('move', (d) => { d.x = 1; }, 'm'); now += 2000;
    h.record('move', (d) => { d.x = 2; }, 'm');
    expect(doc.x).toBe(2);
    h.undo();
    expect(doc.x).toBe(1); // only the 2nd step (a separate entry after the dwell)
    h.undo();
    expect(doc.x).toBe(0);
  });

  it('a fresh gesture starts a new entry (does not merge with the prior drag)', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => 1000);
    const { doc, h } = makeDoc();
    h.beginGesture();
    h.record('move', (d) => { d.x = 1; }, 'm');
    h.endGesture();
    h.beginGesture();
    h.record('move', (d) => { d.x = 5; }, 'm');
    h.endGesture();
    expect(doc.x).toBe(5);
    h.undo();
    expect(doc.x).toBe(1); // second drag is its own undo entry
    h.undo();
    expect(doc.x).toBe(0);
  });
});
