/**
 * Static neutral placeholder for video-clip preview strips.
 *
 * Real frame thumbnails come from the decode/cache path (`thumbnail-controller`
 * + `drawRealReel`/`drawSourceFrame`). These helpers are only the NO-MEDIA
 * fallback: a flat dim fill so an empty strip reads as neutral/blank — no
 * animation, no procedural shapes.
 */

/** Flat dim fill used wherever a real thumbnail is missing. */
export const PLACEHOLDER_FILL = '#1a1a1f';

/** Fill a single cell/panel area with the neutral placeholder (no animation). */
export function drawPlaceholderCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = PLACEHOLDER_FILL;
  ctx.fillRect(x, y, w, h);
}

/** Fill a w×h strip area with the neutral placeholder (ctx already DPR-scaled). */
export function drawFilmReel(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  if (h <= 2) return;
  drawPlaceholderCell(ctx, 0, 0, w, h);
}
