/**
 * Procedural thumbnail strip stand-in for video-clip previews (Milestone 1).
 *
 * The real system will generate + cache actual frame thumbnails (a dedicated
 * decode/cache path). For the mockup we draw a row of frame cells that fill the
 * clip body, each holding a geometric shape that *morphs* across the clip
 * (sides, rotation, hue, scale) so the eye reads left→right progression. No
 * film-strip perforations — the frames read more directly.
 */

const TAU = Math.PI * 2;

/** Draw one "frame" (backing + morphing shape) into a cell. t = progression 0..1. */
export function drawFrameCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  t: number,
): void {
  const hue = (seed * 47 + t * 210) % 360;
  ctx.fillStyle = `hsl(${hue}, 32%, 13%)`;
  ctx.fillRect(x, y, w, h);
  const sides = 3 + Math.round(2 + 2 * Math.sin(seed * 0.7 + t * TAU));
  const rot = t * TAU * 0.5 + seed * 1.3;
  const r = Math.min(w, h) * 0.3 * (0.72 + 0.28 * Math.sin(t * Math.PI * 3 + seed * 2.1));
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.beginPath();
  for (let k = 0; k < sides; k++) {
    const a = rot + (k / sides) * TAU;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r * 0.92;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = `hsl(${(hue + 40) % 360}, 60%, 58%)`;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = `hsl(${(hue + 40) % 360}, 60%, 78%)`;
  ctx.stroke();
}

/** Stable seed from a clip id. */
export function reelSeedFor(id: string): number {
  let s = 0;
  for (const c of id) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return (s % 1000) / 7;
}

/** Draw a thumbnail strip filling a w×h CSS-pixel area (ctx already DPR-scaled). */
export function drawFilmReel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  progress = 0, // 0..1 playhead within the clip (optional highlight)
): void {
  ctx.clearRect(0, 0, w, h);
  if (h <= 2) return;

  // 16:9 frame cells across the full height (matches real video frames).
  const cellW = Math.max(8, h * (16 / 9));
  const n = Math.max(1, Math.round(w / cellW));
  const step = w / n;

  for (let i = 0; i < n; i++) {
    const x = i * step;
    const t = (i + 0.5) / n; // progression along the clip
    drawFrameCell(ctx, x + 0.5, 0, step - 1, h, seed, t);
    if (i > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x, 0, 1, h);
    }
  }

  // Optional playhead-within-clip tick.
  if (progress > 0 && progress < 1) {
    ctx.fillStyle = 'rgba(255,140,0,0.9)';
    ctx.fillRect(progress * w, 0, 1.5, h);
  }
}
