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

/**
 * Overlay marking a cell's thumbnail as STALE — a substituted frame from a nearby
 * time or an older param fingerprint, shown while the up-to-date one is (re)captured.
 * A dim veil (darkens regardless of content luma, so it reads even on B&W frames)
 * plus a faint diagonal hatch that says "not final".
 */
export function drawStaleCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = 'rgba(6,6,10,0.42)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const step = 7;
  for (let d = -h; d < w; d += step) {
    ctx.beginPath();
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
    ctx.stroke();
  }
  ctx.restore();
}
