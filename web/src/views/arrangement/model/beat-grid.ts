/**
 * Beat ⇄ pixel transform with a *warped* grid (Innovation 1).
 *
 * A warp locally speeds/slows the beat grid. We model the instantaneous tempo
 * multiplier m(beat) = 1 + Σ amplitude·wave((beat - start)/period + phase) over
 * the active warp segments, and integrate it to "warped units":
 *
 *     unitsAt(beat) = ∫₀ᵇᵉᵃᵗ m(b) db
 *
 * Because each wave averages ~0 over a period, warped units ≈ beats on average,
 * so `pxPerBeat` keeps its intuitive meaning. Grid lines at integer beats land
 * at non-uniform pixel positions → they visibly clump (m<1) and spread (m>1).
 *
 * Pure + cheap: a cumulative trapezoid table sampled every `STEP` beats, with
 * linear interpolation forward and binary search for the inverse (hit-testing).
 */

import type { WarpSegment } from './composition';

const STEP = 0.125; // beats per integration sample

function waveValue(kind: WarpSegment['waveform'], phase: number): number {
  const p = phase - Math.floor(phase); // [0,1)
  switch (kind) {
    case 'sine':
      return Math.sin(p * Math.PI * 2);
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'triangle':
      return p < 0.5 ? p * 4 - 1 : 3 - p * 4;
    case 'saw':
      return p * 2 - 1;
  }
}

/** Summed warp deviation at a beat (≈ -amp..amp), for the beat-warp lane curve. */
export function warpDeviationAt(segments: WarpSegment[], beat: number): number {
  let s = 0;
  for (const seg of segments) {
    if (beat < seg.startBeat || beat > seg.endBeat) continue;
    const local = (beat - seg.startBeat) / seg.periodBeats + seg.phase;
    s += seg.amplitude * waveValue(seg.waveform, local);
  }
  return s;
}

function tempoMultiplier(segments: WarpSegment[], beat: number): number {
  let m = 1;
  for (const s of segments) {
    if (beat < s.startBeat || beat > s.endBeat) continue;
    const local = (beat - s.startBeat) / s.periodBeats + s.phase;
    // Clamp the multiplier so it never goes non-positive (grid can't reverse).
    m += s.amplitude * waveValue(s.waveform, local);
  }
  return Math.max(0.15, m);
}

export class WarpCurve {
  private readonly cum: number[] = []; // cumulative warped units at i*STEP beats
  readonly totalBeats: number;

  constructor(segments: WarpSegment[], totalBeats: number) {
    this.totalBeats = totalBeats;
    const n = Math.ceil(totalBeats / STEP) + 1;
    let acc = 0;
    let prevM = tempoMultiplier(segments, 0);
    this.cum.push(0);
    for (let i = 1; i < n; i++) {
      const beat = i * STEP;
      const m = tempoMultiplier(segments, beat);
      acc += ((prevM + m) / 2) * STEP; // trapezoid
      this.cum.push(acc);
      prevM = m;
    }
  }

  /** Warped units at a beat (linear interp, clamped/extrapolated). */
  unitsAt(beat: number): number {
    if (beat <= 0) return beat; // neutral before origin
    const f = beat / STEP;
    const i = Math.floor(f);
    if (i >= this.cum.length - 1) {
      // Extrapolate beyond the table at neutral tempo (slope 1).
      const last = this.cum[this.cum.length - 1];
      return last + (beat - (this.cum.length - 1) * STEP);
    }
    const t = f - i;
    return this.cum[i] * (1 - t) + this.cum[i + 1] * t;
  }

  /** Inverse: the beat at a given warped-units position (binary search). */
  beatAt(units: number): number {
    if (units <= 0) return units;
    const last = this.cum[this.cum.length - 1];
    if (units >= last) return (this.cum.length - 1) * STEP + (units - last);
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < units) lo = mid + 1;
      else hi = mid;
    }
    // cum[lo] >= units >= cum[lo-1]
    const i = Math.max(1, lo);
    const u0 = this.cum[i - 1];
    const u1 = this.cum[i];
    const t = u1 > u0 ? (units - u0) / (u1 - u0) : 0;
    return (i - 1 + t) * STEP;
  }
}

/** View transform: warp curve + zoom (px per beat) + horizontal scroll. */
export class BeatGrid {
  constructor(
    readonly curve: WarpCurve,
    readonly pxPerBeat: number,
    /** Left edge of the viewport, in warped units. */
    readonly scrollUnits: number,
  ) {}

  beatToX(beat: number): number {
    return (this.curve.unitsAt(beat) - this.scrollUnits) * this.pxPerBeat;
  }

  xToBeat(x: number): number {
    return this.curve.beatAt(this.scrollUnits + x / this.pxPerBeat);
  }

  /** Width in px of a beat span (accounts for warp across the span). */
  spanWidth(startBeat: number, lengthBeat: number): number {
    return this.beatToX(startBeat + lengthBeat) - this.beatToX(startBeat);
  }

  /**
   * Integer beat lines visible in [0, widthPx], as {beat, x, isBar}. `beatsPerBar`
   * marks downbeats. Steps by `stride` beats to avoid over-dense lines when
   * zoomed out.
   */
  visibleBeatLines(
    widthPx: number,
    beatsPerBar: number,
    stride = 1,
  ): Array<{ beat: number; x: number; isBar: boolean }> {
    const startBeat = Math.max(0, Math.floor(this.xToBeat(0)));
    const endBeat = Math.ceil(this.xToBeat(widthPx));
    const lines: Array<{ beat: number; x: number; isBar: boolean }> = [];
    const first = Math.floor(startBeat / stride) * stride;
    for (let b = first; b <= endBeat; b += stride) {
      lines.push({ beat: b, x: this.beatToX(b), isBar: b % beatsPerBar === 0 });
    }
    return lines;
  }
}
