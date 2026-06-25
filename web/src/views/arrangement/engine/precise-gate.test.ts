import { describe, it, expect } from 'vitest';
import { videoInputsReady, shouldHoldPrecise, pumpActiveSet } from './precise-gate';

/**
 * Precise mode = never composite a frame whose video inputs aren't all ready. Each case
 * here corresponds to a bug that flashed the layers beneath an unready video — see
 * memory: precise-transport-gate.
 */
const clip = (id: string) => ({ clipId: id });

describe('videoInputsReady', () => {
  const allReady = () => true;
  const noneReady = () => false;

  it('no video clips ⇒ ready (nothing to wait on)', () => {
    expect(videoInputsReady([], false, noneReady)).toBe(true);
    expect(videoInputsReady([], true, noneReady)).toBe(true);
  });

  it('video clips present but NO pump yet ⇒ NOT ready (the fresh-page flash)', () => {
    // The regression: a lazily-created pump (this.video null) used to report "ready",
    // so the first landing on a video composited it transparent.
    expect(videoInputsReady([clip('a')], false, allReady)).toBe(false);
  });

  it('with a pump, every active clip must have its frame injected', () => {
    expect(videoInputsReady([clip('a')], true, allReady)).toBe(true);
    expect(videoInputsReady([clip('a')], true, noneReady)).toBe(false);
    // One ready, one not ⇒ not ready (waits for the LAST one).
    const ready = new Set(['a']);
    expect(videoInputsReady([clip('a'), clip('b')], true, (id) => ready.has(id))).toBe(false);
    ready.add('b');
    expect(videoInputsReady([clip('a'), clip('b')], true, (id) => ready.has(id))).toBe(true);
  });
});

describe('shouldHoldPrecise', () => {
  const base = { precise: true, force: false, activeVideoCount: 1, ready: false };

  it('holds only in precise mode, with unready active video, and not forced', () => {
    expect(shouldHoldPrecise(base)).toBe(true);
  });
  it('does not hold when ready', () => {
    expect(shouldHoldPrecise({ ...base, ready: true })).toBe(false);
  });
  it('does not hold in live (non-precise) mode', () => {
    expect(shouldHoldPrecise({ ...base, precise: false })).toBe(false);
  });
  it('does not hold with no active video (a solid-only composite is instant)', () => {
    expect(shouldHoldPrecise({ ...base, activeVideoCount: 0 })).toBe(false);
  });
  it('force (fail-safe timeout) bypasses the hold', () => {
    expect(shouldHoldPrecise({ ...base, force: true })).toBe(false);
  });
});

describe('pumpActiveSet', () => {
  it('committing ⇒ just the target set (old on-screen clips drop)', () => {
    const set = pumpActiveSet(false, [clip('b')], [clip('a')]);
    expect(set.map((c) => c.clipId)).toEqual(['b']);
  });

  it('holding ⇒ keeps the on-screen clips alive alongside the target', () => {
    // A→B hold: B (target/warm) + A (displayed) both stay, so A's texture survives.
    const set = pumpActiveSet(true, [clip('b')], [clip('a')]);
    expect(set.map((c) => c.clipId).sort()).toEqual(['a', 'b']);
  });

  it('holding de-dupes by clipId, target wins (carries the current desc)', () => {
    const target: Array<{ clipId: string; tag: string }> = [{ clipId: 'a', tag: 'target' }];
    const displayed: Array<{ clipId: string; tag: string }> = [{ clipId: 'a', tag: 'displayed' }];
    const set = pumpActiveSet(true, target, displayed);
    expect(set).toEqual([{ clipId: 'a', tag: 'target' }]); // one entry, target's
  });
});
