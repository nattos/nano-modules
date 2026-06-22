/**
 * Beat warp testbed boot — Component E harness.
 *
 * Renders the warped beat grid (clumping/spreading) and the secondsAt(beat)
 * seek curve from the SAME offline WarpCurve, and exposes window.__warp so
 * Puppeteer can assert: identity grid is evenly spaced, warped grid is not, and
 * beat⇄seconds round-trips.
 */

import { BeatGrid, WarpCurve } from './views/arrangement/model/beat-grid';
import { makeWarpClock, precomputeWarp, WarpClock } from './views/arrangement/engine/warp-clock';
import { emptyComposition, type Composition } from './views/arrangement/model/composition';

const PX_PER_BEAT = 24;
const N_BEATS = 32;

function buildComp(warp: boolean): Composition {
  const c = emptyComposition();
  c.meta.baseBPM = 120;
  c.tracks.push({
    id: 't', name: 'T', kind: 'track', parentId: null,
    sketch: { devices: [] }, automation: [], clips: [{
      id: 'c', name: 'C', startBeat: 0, lengthBeat: N_BEATS, kind: 'effect',
      sketch: { devices: [] }, loop: { mode: 'hold' }, automation: [], exports: [],
      warps: warp
        ? [{ id: 'w', sourceDeviceId: 'd', waveform: 'sine', amplitude: 0.45, periodBeats: 8, phase: 0 }]
        : [],
    }],
  });
  return c;
}

let warpOn = true;
let curve: WarpCurve;
let clock: WarpClock;
let grid: BeatGrid;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const status = document.getElementById('status')!;
const toggle = document.getElementById('toggle')!;

function rebuild() {
  const comp = buildComp(warpOn);
  curve = precomputeWarp(comp);
  clock = makeWarpClock(comp);
  grid = new BeatGrid(curve, PX_PER_BEAT, 0);
  toggle.textContent = `Warp: ${warpOn ? 'on' : 'off'}`;
  toggle.className = warpOn ? 'on' : '';
  draw();
}

function beatLineXs(n = N_BEATS): number[] {
  const xs: number[] = [];
  for (let b = 0; b <= n; b++) xs.push(grid.beatToX(b));
  return xs;
}

/** Variance of gaps between consecutive integer-beat lines (0 ⇒ perfectly even). */
function spacingVariance(): number {
  const xs = beatLineXs();
  const gaps: number[] = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Top: warped grid lines.
  const gridBottom = h * 0.5;
  for (const { beat, x, isBar } of grid.visibleBeatLines(w, 4)) {
    ctx.strokeStyle = isBar ? '#A07CE0' : '#2a2e38';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, gridBottom);
    ctx.stroke();
    void beat;
  }

  // Bottom: secondsAt(beat) curve over the same x (warped) axis.
  ctx.strokeStyle = '#46C2C2';
  ctx.beginPath();
  const dur = clock.secondsAt(N_BEATS) || 1;
  for (let b = 0; b <= N_BEATS; b += 0.25) {
    const x = grid.beatToX(b);
    const y = h - (clock.secondsAt(b) / dur) * (h - gridBottom - 8) - 6;
    if (b === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  status.textContent =
    `spacing variance ${spacingVariance().toFixed(2)} · duration ${clock.durationSeconds.toFixed(2)}s · ` +
    `localS/beat@2 ${clock.localSecondsPerBeat(2).toFixed(3)} @6 ${clock.localSecondsPerBeat(6).toFixed(3)}`;
}

toggle.addEventListener('click', () => { warpOn = !warpOn; rebuild(); });
rebuild();

(window as any).__warp = {
  get clock() { return clock; },
  setWarp(on: boolean) { warpOn = on; rebuild(); },
  beatLineXs,
  spacingVariance,
  roundtrip: (beat: number) => clock.beatAtSeconds(clock.secondsAt(beat)),
  secondsAt: (beat: number) => clock.secondsAt(beat),
};
