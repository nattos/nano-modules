/**
 * floating-layout — a tiny deterministic non-overlap solver for "floating"
 * UI chrome (MMO-style name badges, info cards) that want to sit near an anchor
 * but must not pile on top of each other.
 *
 * Each item declares a desired CENTER (`anchorX/anchorY`), a box size, and
 * per-axis anchor *weights*. A high weight on an axis means "I really want to
 * stay at my anchor on this axis" — so the item moves less along it when
 * resolving overlaps. This lets rail badges pin hard in Y (stay in the top band)
 * while sliding freely in X to dodge neighbours, and lets cards anchor softly.
 *
 * The solver is pure and deterministic (no RNG / no time) so it's trivially
 * unit-testable and stable frame-to-frame.
 */

export interface Floater {
  id: string;
  /** Desired center. */
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  /** Pull strength toward the anchor on each axis (>0). Default 1. Higher = stiffer. */
  weightX?: number;
  weightY?: number;
}

export interface FloaterPos {
  /** Resolved center. */
  x: number;
  y: number;
}

export interface LayoutOptions {
  /** Main relaxation passes (separate + pull). Default 60. */
  iterations?: number;
  /** Per-pass pull-toward-anchor base factor (scaled by weight). Default 0.2. */
  pull?: number;
  /** Extra empty space enforced between boxes. Default 0. */
  gap?: number;
  /** Optional clamp region for centers' boxes. */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

interface Node {
  id: string;
  ax: number; ay: number;
  hw: number; hh: number;   // half extents (incl. gap)
  wx: number; wy: number;   // weights
  x: number; y: number;     // current center
}

/**
 * Resolve non-overlapping positions for a set of floaters. Returns a map from
 * id → resolved center. Deterministic for a given input (pair order is by
 * index; ties at identical anchors break by index so lower-index goes first).
 */
export function layoutFloaters(items: Floater[], opts: LayoutOptions = {}): Map<string, FloaterPos> {
  const iterations = opts.iterations ?? 60;
  const pull = opts.pull ?? 0.2;
  const halfGap = (opts.gap ?? 0) / 2;
  const b = opts.bounds;

  const nodes: Node[] = items.map(it => ({
    id: it.id,
    ax: it.anchorX, ay: it.anchorY,
    hw: it.width / 2 + halfGap, hh: it.height / 2 + halfGap,
    wx: Math.max(it.weightX ?? 1, 1e-3),
    wy: Math.max(it.weightY ?? 1, 1e-3),
    x: it.anchorX, y: it.anchorY,
  }));

  const clamp = (n: Node) => {
    if (!b) return;
    n.x = Math.min(Math.max(n.x, b.minX + n.hw), b.maxX - n.hw);
    n.y = Math.min(Math.max(n.y, b.minY + n.hh), b.maxY - n.hh);
  };

  // Push one overlapping pair apart along the cheaper-to-move axis (lower
  // combined weight). Distributes the separation inversely to weight.
  const separatePair = (i: number, j: number) => {
    const a = nodes[i], c = nodes[j];
    const dx = c.x - a.x, dy = c.y - a.y;
    const penX = (a.hw + c.hw) - Math.abs(dx);
    const penY = (a.hh + c.hh) - Math.abs(dy);
    if (penX <= 0 || penY <= 0) return; // not overlapping

    const costX = a.wx + c.wx;
    const costY = a.wy + c.wy;
    if (costX <= costY) {
      const s = dx !== 0 ? Math.sign(dx) : (i < j ? 1 : -1);
      const shareA = c.wx / costX, shareC = a.wx / costX;
      a.x -= s * penX * shareA;
      c.x += s * penX * shareC;
    } else {
      const s = dy !== 0 ? Math.sign(dy) : (i < j ? 1 : -1);
      const shareA = c.wy / costY, shareC = a.wy / costY;
      a.y -= s * penY * shareA;
      c.y += s * penY * shareC;
    }
  };

  const separateAll = () => {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) separatePair(i, j);
    }
    for (const n of nodes) clamp(n);
  };

  const pullAll = () => {
    for (const n of nodes) {
      n.x += (n.ax - n.x) * Math.min(n.wx * pull, 1);
      n.y += (n.ay - n.y) * Math.min(n.wy * pull, 1);
      clamp(n);
    }
  };

  for (let pass = 0; pass < iterations; pass++) {
    separateAll();
    pullAll();
  }
  // Final separation-only passes so the result ends fully non-overlapping (the
  // pull above can re-introduce a sliver of overlap at equilibrium). Gauss-
  // Seidel propagation through a packed row needs ~O(N) passes, so scale with N.
  const finalPasses = Math.max(20, nodes.length * 6);
  for (let pass = 0; pass < finalPasses; pass++) separateAll();

  const out = new Map<string, FloaterPos>();
  for (const n of nodes) out.set(n.id, { x: n.x, y: n.y });
  return out;
}

/** True if two floaters' boxes (at the given centers) overlap. */
export function floatersOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  eps = 1e-3, // sub-pixel: ignore float residue from the relaxation
): boolean {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 - eps
      && Math.abs(a.y - b.y) < (a.height + b.height) / 2 - eps;
}
