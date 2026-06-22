/**
 * Arrangement engine testbed boot — Component C harness.
 *
 * Boots an ArrEngine (reusing the real engine worker), renders a known-good
 * real sketch through executor.wasm, and draws the traced frames to a canvas.
 * Puppeteer (GPU e2e) drives window.__arrEngine to assert real pixels.
 */

import { ArrEngine } from './views/arrangement/engine/arr-engine';
import { gpuTestSketch, invertSketch } from './views/arrangement/engine/slice-sketches';

const canvas = document.getElementById('mon') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const status = document.getElementById('status')!;

let frames = 0;
const engine = new ArrEngine(256, 256);

engine.onFrame = (_id, bitmap) => {
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  frames++;
  status.textContent = `frames: ${frames}`;
};
engine.onError = (m) => { status.textContent = `error: ${m}`; };
engine.ready.then(() => { status.textContent = 'ready'; });

document.getElementById('blue')!.addEventListener('click', () => void show('blue'));
document.getElementById('tris')!.addEventListener('click', () => void show('tris'));

async function show(which: 'blue' | 'tris') {
  frames = 0;
  // 'tris' historically meant "the other scene"; now a real invert chain.
  const s = which === 'blue' ? gpuTestSketch('arr-monitor') : invertSketch('arr-monitor');
  // Distinct sketch id per content; switching is a trace re-target.
  const id = which === 'blue' ? 'sk-blue' : 'sk-tris';
  await engine.showSketch(id, s.sketch, s.opts);
}

const readCenter = () => {
  const x = Math.floor(canvas.width / 2);
  const y = Math.floor(canvas.height / 2);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
};

(window as any).__arrEngine = {
  engine,
  show,
  showGpuTest: () => show('blue'),
  showSpinningTris: () => show('tris'),
  get frames() { return frames; },
  readCenter,
};
