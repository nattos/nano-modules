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

/** Minimum on-screen spacing (px) between adjacent grid lines / snap points. */
export const GRID_MIN_PX = 22;

/**
 * THE grid step, in beats — the single source of truth for BOTH the drawn grid
 * lines and the snap quantization, so what you see is exactly what you snap to.
 * (Two independent ladders used to drift apart: lines every beat while snapping
 * to ¼ beats, so a "1px" drag could jump the edge by a quarter beat.)
 *
 * The ladder halves below a beat and then climbs in BARS (Live's 1/16 … ¼ note,
 * 1 bar, 2 bars, …), so every line is either a beat subdivision or a downbeat —
 * never an off-bar multiple that reads as noise under the bar lines.
 */
export function gridStepBeats(pxPerBeat: number, beatsPerBar: number): number {
  const bpb = Math.max(1, beatsPerBar);
  const min = GRID_MIN_PX / Math.max(1e-6, pxPerBeat); // beats needed for MIN px
  for (const s of [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]) if (s >= min) return s;
  let step = bpb;
  while (step < min) step *= 2;
  return step;
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
   * Grid lines visible in [0, widthPx], as {beat, x, isBar, isBeat}. `step` is the
   * spacing in beats (see `gridStepBeats` — the same value the snap quantizer
   * uses, so the drawn grid IS the snap grid); it may be fractional. `beatsPerBar`
   * marks downbeats, and `isBeat` marks whole beats (false for subdivisions), so
   * callers can draw three weights.
   */
  visibleBeatLines(
    widthPx: number,
    beatsPerBar: number,
    step = 1,
  ): Array<{ beat: number; x: number; isBar: boolean; isBeat: boolean }> {
    const s = step > 1e-9 ? step : 1;
    const bpb = Math.max(1, beatsPerBar);
    const startBeat = Math.max(0, this.xToBeat(0));
    const endBeat = this.xToBeat(widthPx);
    const lines: Array<{ beat: number; x: number; isBar: boolean; isBeat: boolean }> = [];
    // Index off `s` rather than accumulating, so a fractional step can't drift.
    const k0 = Math.floor(startBeat / s);
    const isMultiple = (v: number, of: number) =>
      Math.abs(v / of - Math.round(v / of)) < 1e-6;
    for (let k = k0; ; k++) {
      const b = k * s;
      if (b > endBeat + 1e-9) break;
      if (b < -1e-9) continue;
      lines.push({
        beat: b, x: this.beatToX(b),
        isBar: isMultiple(b, bpb), isBeat: isMultiple(b, 1),
      });
    }
    return lines;
  }
}
