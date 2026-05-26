/**
 * Playhead controllers — Resolume-style clip play modes.
 *
 * A Playhead computes a frame index at any given wall-clock time. The
 * testbed page wires one of these between its requestAnimationFrame
 * loop and `VideoPlaybackService.pull()`. Pure logic — no GPU, no IO,
 * easy to unit-test the timing math without booting a browser.
 *
 * Design — position as state, not a global accumulator:
 *   The playhead position (`pos`, in frame units) is the source of
 *   truth. Each `frameAt()` advances it by `dt * fps * speed`, then
 *   wraps/reflects it within the *current* [inFrame, outFrame]. This
 *   has three consequences that the old "position = mod(elapsed * rate,
 *   range)" shape couldn't deliver:
 *     1. Changing fps/speed only changes how fast `pos` moves — never
 *        where it is (no leap on a speed slider).
 *     2. Changing inFrame/outFrame doesn't remap `pos`: playback
 *        continues from wherever it was. The head only jumps if the new
 *        range no longer contains the current position (then it's
 *        forced in — the one sanctioned jump).
 *     3. No mode ever stops at the end: loop / reverse-loop wrap,
 *        ping-pong reflects, random-jumps wraps between jumps.
 */

export type ControllerKind =
  | 'loop'
  | 'reverse-loop'
  | 'pingpong'
  | 'random-jumps'
  | 'hold';

export interface ControllerParams {
  kind: ControllerKind;
  /** First frame of the active range, inclusive. */
  inFrame: number;
  /** Last frame of the active range, inclusive. */
  outFrame: number;
  /** Frames-per-second of playback (independent of source fps). */
  fps: number;
  /** Speed multiplier (1 = normal, 2 = 2× fast-forward). Negative
   *  reverses loop / reverse-loop; ping-pong & random-jumps use the
   *  magnitude only (their direction is intrinsic). */
  speed: number;
  // --- mode-specific ---
  /** `random-jumps`: time between jumps, in ms. After each jump the
   *  playhead resumes forward play (wrapping in range) until the next. */
  jumpEveryMs?: number;
  /** `hold`: the frame the playhead sits on. Defaults to `inFrame`. */
  holdFrame?: number;
}

/** Tiny epsilon (in frames) added before flooring to display, so a
 *  position that should be exactly N but lands at N − 1e-15 from
 *  floating-point rounding still reads as frame N. Far below any
 *  perceptible sub-frame threshold; well above accumulated FP drift. */
const DISPLAY_EPS = 1e-9;

export class Playhead {
  params: ControllerParams;
  frameCount: number;
  private rng: () => number;

  /** Current playhead position, in frame units (continuous). */
  private pos = 0;
  /** Travel direction for ping-pong (+1 / −1). Persists across range
   *  edits so a mid-bounce range change keeps heading the same way. */
  private dir = 1;
  private lastNowMs = 0;
  private lastJumpMs = 0;

  constructor(
    params: ControllerParams,
    frameCount: number,
    rng: () => number = Math.random,
  ) {
    this.params = params;
    this.frameCount = frameCount;
    this.rng = rng;
    this.pos = params.inFrame;
  }

  start(nowMs: number): void {
    const p = this.params;
    // reverse-loop reads most naturally starting at the out point and
    // counting down; everything else starts at the in point.
    this.pos = p.kind === 'reverse-loop' ? p.outFrame : p.inFrame;
    this.dir = 1;
    this.lastNowMs = nowMs;
    this.lastJumpMs = nowMs;
  }

  /** Reset the controller's internal state without changing params. */
  reset(nowMs: number): void { this.start(nowMs); }

  frameAt(nowMs: number): number {
    const p = this.params;
    const fps = Number.isFinite(p.fps) ? Math.max(0.0001, p.fps) : 30;
    const speed = Number.isFinite(p.speed) ? p.speed : 1;

    // Frames to advance this step. Position-state model: the rate only
    // scales the per-step delta, so changing fps/speed never relocates
    // the head — it just moves faster/slower from here on.
    const dt = Math.max(0, (nowMs - this.lastNowMs) / 1000);
    this.lastNowMs = nowMs;
    const advance = dt * fps * speed;     // signed

    const lo = Math.min(p.inFrame, p.outFrame);
    const hi = Math.max(p.inFrame, p.outFrame);

    switch (p.kind) {
      case 'loop':
        this.pos = wrapPos(this.pos + advance, lo, hi);
        break;
      case 'reverse-loop':
        this.pos = wrapPos(this.pos - advance, lo, hi);
        break;
      case 'pingpong': {
        const [np, nd] = reflectPos(this.pos + Math.abs(advance) * this.dir, lo, hi, this.dir);
        this.pos = np;
        this.dir = nd;
        break;
      }
      case 'random-jumps': {
        const interval = Math.max(50, p.jumpEveryMs ?? 2000);
        if (nowMs - this.lastJumpMs >= interval) {
          this.lastJumpMs = nowMs;
          const span = hi - lo + 1;
          // Jump to a random frame in [lo, hi]; clamp off the open end.
          this.pos = lo + Math.min(span - 1e-6, this.rng() * span);
        } else {
          // Forward play between jumps — wraps so it never sticks at hi.
          this.pos = wrapPos(this.pos + Math.abs(advance), lo, hi);
        }
        break;
      }
      case 'hold':
        return clampToCount(Math.floor(p.holdFrame ?? p.inFrame), this.frameCount);
    }

    // The range may have shrunk under us (in/out moved). Force the head
    // into the current range — the ONLY jump these controllers ever
    // make. If the position is still inside, wrap/reflect above already
    // left it untouched, so no jump happens.
    if (this.pos < lo) this.pos = lo;
    else if (this.pos > hi + 1) this.pos = hi + 1;

    const frame = Math.floor(this.pos + DISPLAY_EPS);
    return clampToCount(Math.min(hi, Math.max(lo, frame)), this.frameCount);
  }
}

/**
 * Wrap a continuous position cyclically into the cell range [lo, hi]
 * (inclusive). Each integer frame is a unit cell, so the wrap span is
 * `hi − lo + 1`. Identity when `pos` is already in range — that's what
 * makes an in-range slider edit produce no jump.
 */
function wrapPos(pos: number, lo: number, hi: number): number {
  const span = hi - lo + 1;
  if (span <= 0) return lo;
  return lo + mod(pos - lo, span);
}

/**
 * Reflect a continuous position into [lo, hi] (the discrete frame
 * endpoints), flipping direction at each bounce. Loops for arbitrarily
 * large overshoot (very high speed / a big dt). Identity when in range.
 * Returns the reflected position and the post-reflection direction.
 */
function reflectPos(pos: number, lo: number, hi: number, dir: number): [number, number] {
  if (hi <= lo) return [lo, dir];
  let p = pos;
  let d = dir;
  let guard = 0;
  while ((p > hi || p < lo) && guard++ < 10000) {
    if (p > hi) { p = 2 * hi - p; d = -1; }
    else        { p = 2 * lo - p; d = 1; }
  }
  return [p, d];
}

function mod(x: number, m: number): number {
  // True modulo (handles negatives so reverse play wraps correctly).
  const r = x % m;
  return r < 0 ? r + m : r;
}

function clampToCount(idx: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= frameCount) return frameCount - 1;
  return Math.floor(idx);
}

/** Sensible default params for each mode — used by the testbed UI on
 *  first selection and as the prefill when switching modes. */
export function defaultParams(kind: ControllerKind, frameCount: number, fps = 30): ControllerParams {
  const last = Math.max(0, frameCount - 1);
  const base: ControllerParams = {
    kind, inFrame: 0, outFrame: last, fps, speed: 1,
  };
  if (kind === 'random-jumps') base.jumpEveryMs = 1500;
  if (kind === 'hold') base.holdFrame = Math.floor(last / 2);
  return base;
}
