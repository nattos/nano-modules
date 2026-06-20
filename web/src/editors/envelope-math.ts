/**
 * Envelope curve math — the TS mirror of native/src/sketch/envelope.h.
 *
 * Used LIVE by the envelope graph editor (envelope-inspector.ts) to draw the
 * curve, so it must match the effect's eval conceptually. DOM-free + pure so it
 * stays unit-testable (envelope-math.test.ts mirrors native test_envelope.cpp).
 */

export interface EnvPoint { x: number; y: number; ease: number }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);

/** Shape t∈[0,1] by ease∈[-1,1]: exponent = 2^(-3·ease); endpoints exact. */
export function applyEase(t: number, ease: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (ease === 0) return t;
  return Math.pow(t, Math.pow(2, -3 * ease));
}

/** Evaluate the envelope (points sorted by x) at x; clamps flat outside. */
export function evalEnvelope(pts: EnvPoint[], x: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (n === 1 || x <= pts[0].x) return pts[0].y;
  if (x >= pts[n - 1].x) return pts[n - 1].y;
  for (let i = 0; i < n - 1; i++) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const span = pts[i + 1].x - pts[i].x;
      const t = span > 0 ? (x - pts[i].x) / span : 0;
      return pts[i].y + applyEase(t, pts[i].ease) * (pts[i + 1].y - pts[i].y);
    }
  }
  return pts[n - 1].y;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Serialise points to the flat "[x0,y0,e0, ...]" string the effect parses. */
export function serializeCurve(pts: EnvPoint[]): string {
  return JSON.stringify(pts.flatMap(p => [r4(p.x), r4(p.y), r4(p.ease)]));
}

/** Points → flat number array [x0,y0,e0, ...] (the wire `mod.envelope` format,
 *  which stores the JSON array directly rather than a stringified copy). */
export function curveToArray(pts: EnvPoint[]): number[] {
  return pts.flatMap(p => [r4(p.x), r4(p.y), r4(p.ease)]);
}

/** Parse a flat number array (string or array) into points; falls back to identity. */
export function parseCurve(raw: any): EnvPoint[] {
  let nums: number[] = [];
  try {
    if (typeof raw === 'string') nums = JSON.parse(raw);
    else if (Array.isArray(raw)) nums = raw as number[];
  } catch { nums = []; }
  const pts: EnvPoint[] = [];
  for (let i = 0; i + 2 < nums.length + 1 && i + 1 < nums.length; i += 3) {
    pts.push({
      x: clamp01(+nums[i] || 0),
      y: clamp01(+nums[i + 1] || 0),
      ease: clamp(+nums[i + 2] || 0, -1, 1),
    });
  }
  if (pts.length < 2) return [{ x: 0, y: 0, ease: 0 }, { x: 1, y: 1, ease: 0 }];
  pts.sort((a, b) => a.x - b.x);
  return pts;
}
