/**
 * Arrangement engine testbed boot — Component C harness.
 *
 * Boots an ArrEngine (reusing the real engine worker), renders a known-good
 * real sketch through executor.wasm, and draws the traced frames to a canvas.
 * Puppeteer (GPU e2e) drives window.__arrEngine to assert real pixels.
 */

import { ArrEngine } from './views/arrangement/engine/arr-engine';
import { gpuTestSketch, invertSketch, brightnessWhiteSketch, solidSketch } from './views/arrangement/engine/slice-sketches';
import { buildCompositeSketch, clipInstanceKey, trackInstanceKey } from './views/arrangement/engine/clip-sketch';

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

// Effect-only composite repro: a brightness=1.0 chain shown as the composite
// (sketch id 'comp', the same path the arrangement uses), torn down, recreated.
const COMP = 'comp';
async function showBrightness() {
  frames = 0;
  const s = brightnessWhiteSketch(COMP);
  await engine.showComposite([{ sketchId: COMP, sketch: s.sketch, opts: s.opts }]);
}
async function clearComposite() {
  frames = 0;
  engine.deleteSketch(COMP);
  await engine.showComposite([]); // playhead off all clips → empty composite
}
// Background baked at the COMPOSITOR level: a neutral effect-only clip over a
// custom background, built through buildCompositeSketch — the output should read
// as the background color (the effect passes the bg base through).
async function showBgProbe(color: string) {
  frames = 0;
  const clip = {
    id: 'p',
    sketch: { devices: [{ id: 'b', moduleType: 'color.tone.brightness_contrast', name: '', capabilities: [], state: { brightness: 0, contrast: 0 } }] },
  } as any;
  const r = buildCompositeSketch([{ clip, opacity: 1 }], { mode: 'custom', color });
  if (r) await engine.showComposite([{ sketchId: COMP, sketch: r.sketch, opts: r.opts }]);
}

// UPDATE path: the composite never empties — it's re-issued (updateSketch) with a
// different chain (a plain solid, no brightness), as when the playhead moves to a
// different clip. Returning to the brightness chain must re-render white.
async function showSolidOnly() {
  frames = 0;
  const s = solidSketch(COMP);
  await engine.showComposite([{ sketchId: COMP, sketch: s.sketch, opts: s.opts }]);
}

// Phase-B automation side-channel: drive the showBgProbe clip's brightness via
// engine.setAutomation (the executor folds the normalized value into the field's
// range). Set once; the executor re-applies it every frame until changed.
function setAuto(field: string, value: number, combine = 'replace') {
  engine.setAutomation([
    { instance: clipInstanceKey('p', 'b'), field, value, combine, magnitude: 'unsigned' },
  ]);
}

// Phase: TRACK FX bus — a solid-source clip on a track whose own effect chain
// (brightness_contrast, keyed track_<id>_<dev>) runs over the clip output. Drives
// the TRACK device via setAutomation to prove track automation reaches it.
async function showTrackFxProbe() {
  frames = 0;
  const clip = { id: 'p', sketch: { devices: [
    { id: 's', moduleType: 'source.solid_color', name: '', capabilities: ['generator'], state: { color: [0.4, 0.4, 0.4] } },
  ] } } as any;
  const track = { id: 'tk', sketch: { devices: [
    { id: 'b', moduleType: 'color.tone.brightness_contrast', name: '', capabilities: [], state: { brightness: 0, contrast: 0 } },
  ] } } as any;
  const r = buildCompositeSketch([{ clip, track, opacity: 1 }], { mode: 'transparent' });
  if (r) await engine.showComposite([{ sketchId: COMP, sketch: r.sketch, opts: r.opts }]);
}
function setTrackAuto(field: string, value: number, combine = 'replace') {
  engine.setAutomation([
    { instance: trackInstanceKey('tk', 'b'), field, value, combine, magnitude: 'unsigned' },
  ]);
}

(window as any).__arrEngine = {
  engine,
  show,
  setAuto,
  showTrackFxProbe,
  setTrackAuto,
  showGpuTest: () => show('blue'),
  showSpinningTris: () => show('tris'),
  showBrightness,
  clearComposite,
  showSolidOnly,
  showBgProbe,
  get frames() { return frames; },
  readCenter,
};
