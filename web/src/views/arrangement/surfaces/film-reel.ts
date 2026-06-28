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
 *
 * Generator frames are usually DARK, so we deliberately do NOT darken (that would
 * blend stale cells toward black and kill the contrast against fresh ones). Instead a
 * cool MID-tone wash pulls the cell toward a faded grey — lifting darks, muting brights
 * — plus a bright diagonal hatch that reads as "provisional / refreshing" on any luma.
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
  // Mid-tone wash → "faded", never blacked-out.
  ctx.fillStyle = 'rgba(122,132,156,0.30)';
  ctx.fillRect(x, y, w, h);
  // Bright diagonal hatch → the unmistakable "not final" texture.
  ctx.strokeStyle = 'rgba(232,238,255,0.16)';
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
