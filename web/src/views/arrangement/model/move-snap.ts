/**
 * Where a dragged span LANDS.
 *
 * Two rules, in priority order:
 *
 *  1. The moved span's START lands on the visible grid — the ABSOLUTE start, not
 *     the drag delta. Quantizing the delta preserves whatever off-grid offset the
 *     clip already had, so a clip that began at 1.37 stayed at 1.37 + n·step
 *     forever and could never be lined up by dragging it.
 *  2. Within a small magnet radius, a neighbouring clip EDGE beats the grid: the
 *     moved start snaps to another clip's end, and the moved END snaps to another
 *     clip's start, so clips can be dragged snug against each other even when the
 *     seam falls between grid lines.
 *
 * The magnet radius is expressed in PIXELS so it stays a constant feel across
 * zoom levels, and is much smaller than the grid's own minimum line spacing
 * (`GRID_MIN_PX`) — a magnet can bend a landing, never take the grid over.
 */

/** Neighbouring clip edges a moved span can snap against, in beats. */
export interface SnapEdges {
  /** Other clips' END beats — the moved span's START snaps onto these. */
  clipEnds: number[];
  /** Other clips' START beats — the moved span's END snaps onto these. */
  clipStarts: number[];
}

export const EMPTY_EDGES: SnapEdges = { clipEnds: [], clipStarts: [] };

/** Magnet radius (px on screen) for the clip-edge snap. */
export const EDGE_MAGNET_PX = 10;

export interface MoveSnapOpts {
  /** Unquantized start beat the drag is asking for. */
  targetStart: number;
  /** Length of the moved span in beats (0 for a bare point). */
  lengthBeat: number;
  /** Grid spacing in beats — `store.snapStep`, i.e. the DRAWN grid. */
  step: number;
  /** Zoom, for the px-denominated magnet radius. */
  pxPerBeat: number;
  /** Neighbour edges to consider (empty ⇒ grid only). */
  edges?: SnapEdges;
  magnetPx?: number;
}

/**
 * The start beat a move should land on. Never negative.
 *
 * Free (Alt) drags don't come here at all — the caller keeps the raw beat.
 */
export function snapMoveStart(o: MoveSnapOpts): number {
  const step = o.step > 1e-9 ? o.step : 1;
  const grid = Math.round(o.targetStart / step) * step;

  const edges = o.edges ?? EMPTY_EDGES;
  const magnetBeats = (o.magnetPx ?? EDGE_MAGNET_PX) / Math.max(1e-6, o.pxPerBeat);
  let best = grid;
  let bestDist = Infinity;
  const consider = (start: number) => {
    const d = Math.abs(start - o.targetStart);
    if (d <= magnetBeats && d < bestDist) { bestDist = d; best = start; }
  };
  for (const end of edges.clipEnds) consider(end);
  for (const start of edges.clipStarts) consider(start - o.lengthBeat);

  return Math.max(0, best);
}
