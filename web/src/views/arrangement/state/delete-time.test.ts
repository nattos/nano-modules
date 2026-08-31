import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';

/**
 * "Delete Time" is the RIPPLE cut — the counterpart of Insert Time — and both
 * act on the whole COLUMN of time: every clip lane, not just the tracks the
 * caret spans. A ripple that skipped out-of-scope lanes slid the in-scope ones
 * out of sync with the rest of the arrangement.
 *
 * Plain Delete (`clearTime`) is the scoped one: it clears only the boxed tracks
 * and leaves the hole behind.
 */
describe('deleteTime ripples the whole time column', () => {
  let T: string[];
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
    T = [store.addTrack(), store.addTrack()];
  });

  const startsOf = (trackId: string) =>
    store.composition.tracks.find((t) => t.id === trackId)!.clips
      .map((c) => c.startBeat).sort((a, b) => a - b);

  it('shifts clips on tracks OUTSIDE the caret scope too', () => {
    const [inScope, outOfScope] = T;
    store.createEmptyClip(inScope, 0, 4);
    store.createEmptyClip(inScope, 16, 4);
    store.createEmptyClip(outOfScope, 16, 4);

    // Box beats [4,12) over `inScope` only.
    store.setCaret({
      anchorBeat: 4, anchorTrackId: inScope,
      headBeat: 12, headTrackId: inScope,
    });
    expect(store.timeSelTrackIds).toEqual([inScope]);

    store.deleteTime();

    // 8 beats removed everywhere: both tracks' later clips move to 8.
    expect(startsOf(inScope)).toEqual([0, 8]);
    expect(startsOf(outOfScope)).toEqual([8]);
  });

  it('is exactly undone by an Insert Time of the same span', () => {
    const [a, b] = T;
    store.createEmptyClip(a, 20, 4);
    store.createEmptyClip(b, 20, 4);
    store.setCaret({
      anchorBeat: 4, anchorTrackId: a, headBeat: 8, headTrackId: a,
    });
    store.deleteTime();
    expect(startsOf(a)).toEqual([16]);
    expect(startsOf(b)).toEqual([16]);
    store.insertTimeSpan(4, 4);
    expect(startsOf(a)).toEqual([20]);
    expect(startsOf(b)).toEqual([20]);
  });

  it('plain clearTime stays scoped to the caret tracks', () => {
    const [inScope, outOfScope] = T;
    store.createEmptyClip(inScope, 4, 4);
    store.createEmptyClip(outOfScope, 4, 4);
    store.setCaret({
      anchorBeat: 4, anchorTrackId: inScope, headBeat: 8, headTrackId: inScope,
    });
    store.clearTime();
    expect(startsOf(inScope)).toEqual([]);
    expect(startsOf(outOfScope)).toEqual([4]);
  });
});
