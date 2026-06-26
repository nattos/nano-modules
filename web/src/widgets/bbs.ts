/**
 * Bars · beats · sixteenths conversions (Ableton-style, 1-based).
 *
 * A musical position is carried as a single number of **beats** (the engine's
 * native unit); the UI shows it as `bar.beat.sixteenth`, each component 1-based,
 * e.g. `5.2.1` = bar 5, beat 2, sixteenth 1. `beatsPerBar` comes from the time
 * signature numerator; `sixPerBeat` is sixteenths per beat (4 for a quarter-note
 * beat). Pure + framework-free so it's the unit-test surface for the widget.
 */

export interface BBS {
  /** 1-based bar number. */
  bar: number;
  /** 1-based beat within the bar. */
  beat: number;
  /** 1-based sixteenth within the beat. */
  six: number;
}

const EPS = 1e-9;

/** Decompose a beat position into 1-based bar/beat/sixteenth. */
export function beatsToBBS(beats: number, beatsPerBar: number, sixPerBeat: number): BBS {
  const b = Math.max(0, beats);
  const bar = Math.floor(b / beatsPerBar + EPS);
  const within = b - bar * beatsPerBar;
  const beat = Math.floor(within + EPS);
  const frac = within - beat;
  const six = Math.floor(frac * sixPerBeat + EPS);
  return { bar: bar + 1, beat: beat + 1, six: six + 1 };
}

/**
 * Recompose to a beat position. Linear, so out-of-range components carry/borrow
 * naturally (e.g. beat 6 in 4/4 rolls into the next bar) — which is exactly what
 * makes jogging a single segment past its bound "just work".
 */
export function bbsToBeats(bbs: BBS, beatsPerBar: number, sixPerBeat: number): number {
  return (bbs.bar - 1) * beatsPerBar + (bbs.beat - 1) + (bbs.six - 1) / sixPerBeat;
}

/** `bar.beat.six`. */
export function formatBBS(bbs: BBS): string {
  return `${bbs.bar}.${bbs.beat}.${bbs.six}`;
}

/**
 * Parse a tolerant `bar[.beat[.six]]` string; missing trailing components
 * default to 1. Returns null if no leading number parses. Each component is
 * floored to an integer ≥ 1 EXCEPT it preserves user intent for carry: values
 * are passed through to bbsToBeats which handles overflow, so we only guard the
 * lower bound here.
 */
export function parseBBS(str: string): BBS | null {
  const parts = str.trim().split('.').map((p) => p.trim());
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)));
  if (!Number.isFinite(nums[0])) return null;
  const at = (i: number) => (Number.isFinite(nums[i]) ? Math.max(1, Math.floor(nums[i])) : 1);
  return { bar: at(0), beat: at(1), six: at(2) };
}
