/**
 * Synthetic frame generator for the thumbnail-cache testbeds ONLY.
 *
 * The thumbnail testbeds (`thumbnail-testbed`, `thumbnail-mip-testbed`,
 * `opfs-thumb-testbed`) need a procedural producer that yields a DISTINGUISHABLE
 * image per (source, frame) so the cache/LRU/mip pipeline is verifiable. This is
 * not used by the arrangement UI — clip preview strips render real decoded
 * thumbnails or a static neutral placeholder (see `surfaces/film-reel.ts`).
 */

const TAU = Math.PI * 2;

/** Stable seed from a source/clip id. */
export function reelSeedFor(id: string): number {
  let s = 0;
  for (const c of id) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return (s % 1000) / 7;
}

/** Draw one synthetic frame (backing + morphing shape). t = progression 0..1. */
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
