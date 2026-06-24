/**
 * Automation / rail-curve evaluation (Component F, the lock-step foundation).
 *
 * Arrangement automation lanes and rail base curves are drawn envelopes
 * (`EnvelopePoint[]` = `{x, y, bend}`). Their *values* are evaluated with the
 * SAME eased math the native envelope effect uses, by delegating to the pure TS
 * twin `editors/envelope-math.ts` (`evalEnvelope`, mirror of native
 * `envelope.h`, unit-tested against `test_envelope.cpp`). So an automation curve
 * the user draws here evaluates identically to one driving a real effect — no
 * second, drifting implementation.
 *
 * The only impedance match is the point shape: the arrangement model names the
 * segment ease `bend` (`{x,y,bend}`); envelope-math names it `ease` (`{x,y,ease}`).
 * They are the same quantity (∈[-1,1], 0 = linear, exponent 2^(-3·e), applies to
 * the segment leaving the point), so the map is a direct rename.
 */

import { evalEnvelope, type EnvPoint } from '../../../editors/envelope-math';
import type { EnvelopePoint } from '../model/composition';

/** Arrangement `{x,y,bend}` → envelope-math `{x,y,ease}`, sorted by x. */
export function toEnvPoints(points: EnvelopePoint[]): EnvPoint[] {
  return points
    .map((p) => ({ x: p.x, y: p.y, ease: p.bend ?? 0 }))
    .sort((a, b) => a.x - b.x);
}

/**
 * Evaluate an automation / base curve at normalized x∈[0,1] with the native
 * eased interpolation. Clamps flat outside the point range; 0 for an empty curve.
 */
export function evalCurveAt(points: EnvelopePoint[], xNorm: number): number {
  if (points.length === 0) return 0;
  return evalEnvelope(toEnvPoints(points), xNorm);
}

/**
 * Owner context for a lane, deciding how an arrangement beat maps into the
 * curve's x-domain. A TRACK lane's points carry absolute arrangement beats; a
 * CLIP lane's points are normalized [0,1] over the clip/loop span, wrapping in
 * loop mode and clamping in clip mode.
 */
export type LaneOwnerCtx =
  | { kind: 'track' }
  | { kind: 'clip'; startBeat: number; spanBeats: number; loopMode: boolean };

/**
 * Evaluate a lane at an absolute arrangement beat — the seam the engine calls
 * each frame to drive the lane's target parameter. Returns the normalized curve
 * value (the y∈[0,1] the executor then maps into the field's [min,max]).
 */
export function evalLaneAtBeat(points: EnvelopePoint[], ctx: LaneOwnerCtx, arrangementBeat: number): number {
  if (ctx.kind === 'track') return evalCurveAt(points, arrangementBeat); // points ARE beats
  const span = Math.max(1e-6, ctx.spanBeats);
  const elapsed = arrangementBeat - ctx.startBeat;
  if (elapsed <= 0) return evalCurveAt(points, 0);
  const local = ctx.loopMode ? elapsed % span : Math.min(elapsed, span);
  return evalCurveAt(points, local / span); // clip points are normalized [0,1]
}

/**
 * Sample a curve at `samples+1` evenly spaced points across [0,1]. Used to draw
 * the eased curve as a dense polyline (straight segments between control points
 * would miss the easing). Returns `[xNorm, value]` pairs.
 */
export function sampleCurve(points: EnvelopePoint[], samples: number): Array<[number, number]> {
  const n = Math.max(1, samples);
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    out.push([x, evalCurveAt(points, x)]);
  }
  return out;
}
