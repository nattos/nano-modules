/**
 * Preview input generators — the test pictures the effect store feeds effects.
 *
 * An effect's store thumbnail and hover preview run it on a picture made here,
 * chosen by string key in its preview scenario (`input`, or an aux
 * `generator` node — see native/wasm_modules/include/preview_scenario.h).
 * Each is a PURE function of time: the thumbnail is captured by stepping a
 * fixed clock, so the same scenario always bakes the same picture.
 *
 * They draw with Canvas 2D on an OffscreenCanvas inside the preview engine's
 * worker (an SVG image can't be decoded there, so motion-graphics shapes are
 * Path2D — SVG path syntax — instead).
 *
 * Bump GENERATORS_VERSION whenever any drawing changes: it is part of every
 * cached thumbnail's key.
 */

export const GENERATORS_VERSION = 1;

export type GeneratorDraw = (ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number) => void;

export interface GeneratorDef {
  key: string;
  label: string;
  draw: GeneratorDraw;
}

const TAU = Math.PI * 2;

/** Lots of motion: shapes orbiting and spinning over a slow soft background. */
function motion(ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number) {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${(t * 12) % 360}, 45%, 18%)`);
  bg.addColorStop(1, `hsl(${(t * 12 + 140) % 360}, 45%, 30%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w, h);
  const shapes = 7;
  for (let i = 0; i < shapes; i++) {
    const a = t * (0.6 + i * 0.13) + (i * TAU) / shapes;
    const r = s * (0.18 + 0.05 * i);
    const x = w / 2 + Math.cos(a) * r * 1.4;
    const y = h / 2 + Math.sin(a * 1.3) * r;
    const size = s * (0.07 + 0.02 * (i % 3));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * (1 + i * 0.4));
    ctx.fillStyle = `hsl(${(i * 53 + t * 40) % 360}, 85%, 60%)`;
    if (i % 3 === 0) {
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, TAU);
      ctx.fill();
    } else if (i % 3 === 1) {
      ctx.fillRect(-size, -size, size * 2, size * 2);
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -size * 1.2);
      ctx.lineTo(size * 1.1, size * 0.8);
      ctx.lineTo(-size * 1.1, size * 0.8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Slow, smooth hue and luma sweeps — for tone and colour effects. */
function gradient(ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number) {
  const hue = ctx.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 6; i++) hue.addColorStop(i / 6, `hsl(${(i * 60 + t * 20) % 360}, 90%, 55%)`);
  ctx.fillStyle = hue;
  ctx.fillRect(0, 0, w, h);
  // Luma: black at the bottom to white at the top, drifting.
  const shift = 0.5 + 0.2 * Math.sin(t * 0.7);
  const luma = ctx.createLinearGradient(0, h, 0, 0);
  luma.addColorStop(0, 'rgba(0,0,0,1)');
  luma.addColorStop(shift * 0.8, 'rgba(0,0,0,0)');
  luma.addColorStop(Math.min(1, shift * 0.8 + 0.35), 'rgba(255,255,255,0)');
  luma.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = luma;
  ctx.fillRect(0, 0, w, h);
}

// Built on first draw: Path2D doesn't exist where this module is merely
// imported for its keys (unit tests, the main thread's scenario compiler).
let pathCache: { ring: Path2D; chevron: Path2D } | null = null;
function shapePaths() {
  return pathCache ??= {
    ring: new Path2D('M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z M 0 -0.7 A 0.7 0.7 0 1 0 0 0.7 A 0.7 0.7 0 1 0 0 -0.7 Z'),
    chevron: new Path2D('M -1 -0.6 L 0 0.4 L 1 -0.6 L 1 0 L 0 1 L -1 0 Z'),
  };
}

/** Motion graphics: hard edges, bars, rings and chevrons on a flat ground. */
function edges(ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number) {
  const { ring, chevron } = shapePaths();
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, w, h);
  // Sliding bars.
  const bars = 9;
  for (let i = 0; i < bars; i++) {
    const bw = w / bars;
    const phase = (t * 0.5 + i * 0.37) % 1;
    const bh = h * (0.2 + 0.6 * Math.abs(Math.sin(phase * Math.PI)));
    ctx.fillStyle = i % 2 ? '#f2f2f2' : '#ff3d6e';
    ctx.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
  }
  const s = Math.min(w, h);
  // A pulsing ring.
  ctx.save();
  ctx.translate(w * 0.3, h * 0.38);
  const rs = s * (0.18 + 0.05 * Math.sin(t * 2));
  ctx.scale(rs, rs);
  ctx.fillStyle = '#35e0ff';
  ctx.fill(ring, 'evenodd');
  ctx.restore();
  // Marching chevrons.
  for (let i = 0; i < 4; i++) {
    ctx.save();
    const x = ((t * 0.25 + i / 4) % 1) * (w + s * 0.3) - s * 0.15;
    ctx.translate(x, h * 0.25);
    ctx.rotate(-Math.PI / 2);
    ctx.scale(s * 0.08, s * 0.08);
    ctx.fillStyle = '#ffd23d';
    ctx.fill(chevron);
    ctx.restore();
  }
}

/** Soft, organic blobs with some texture — a stand-in for camera footage. */
function blobs(ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number) {
  ctx.fillStyle = '#1b2230';
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w, h);
  for (let i = 0; i < 6; i++) {
    const x = w * (0.5 + 0.38 * Math.sin(t * 0.3 + i * 1.7));
    const y = h * (0.5 + 0.35 * Math.cos(t * 0.23 + i * 2.3));
    const r = s * (0.25 + 0.1 * Math.sin(t * 0.5 + i));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${(i * 60 + 20) % 360}, 70%, 65%, 0.9)`);
    g.addColorStop(1, `hsla(${(i * 60 + 20) % 360}, 70%, 40%, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // Fine stripes for a little high-frequency detail.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  const step = Math.max(2, Math.round(s / 60));
  for (let y = 0; y < h; y += step * 2) ctx.fillRect(0, y, w, step);
}

/** Opaque black: a backdrop for effects that ADD light onto their input
 *  (with no input they'd add onto transparent black and stay invisible). */
function black(ctx: OffscreenCanvasRenderingContext2D, _t: number, w: number, h: number) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
}

export const GENERATORS: readonly GeneratorDef[] = [
  { key: 'motion', label: 'Motion', draw: motion },
  { key: 'gradient', label: 'Gradient', draw: gradient },
  { key: 'edges', label: 'Edges', draw: edges },
  { key: 'blobs', label: 'Blobs', draw: blobs },
  { key: 'black', label: 'Black', draw: black },
];

export const DEFAULT_GENERATOR = 'motion';

/** The generator for `key`; unknown keys fall back to the default. */
export function generatorFor(key: string): GeneratorDef {
  return GENERATORS.find((g) => g.key === key) ?? GENERATORS.find((g) => g.key === DEFAULT_GENERATOR)!;
}
