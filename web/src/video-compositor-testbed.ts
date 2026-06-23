/**
 * Video compositor testbed — isolates the video → source.video.file → trace path
 * from the arrangement (no monitor / composite / placeholder). Boots an ArrEngine,
 * shows a single `source.video.file` sketch, and lets you inject a synthetic frame
 * (RED/GREEN — no GPU device needed) or decode the DXV test video through the real
 * VideoCompositor. Draws the RAW traced output so we can read the actual pixels.
 *
 *   window.__videoTb.injectColor('red'|'green') / loadDxv() / readCenter()
 */

import { ArrEngine } from './views/arrangement/engine/arr-engine';
import { VideoCompositor } from './views/arrangement/engine/video-compositor';
import type { Sketch } from './sketch-types';

const W = 640;
const H = 360;
const VID_KEY = 'vid';
const canvas = document.getElementById('mon') as HTMLCanvasElement;
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d')!;
const status = document.getElementById('status')!;

let frames = 0;
const engine = new ArrEngine(W, H);
engine.onFrame = (_id, bitmap) => {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bitmap, 0, 0, W, H);
  bitmap.close();
  frames++;
  const c = readCenter();
  status.textContent = `frames: ${frames}  center: [${c.r},${c.g},${c.b},${c.a}]`;
};
engine.onError = (m) => { status.textContent = `error: ${m}`; };

const sketch: Sketch = {
  anchor: null,
  chain: [{ type: 'module', module_type: 'source.video.file', instance_key: VID_KEY }],
  wires: [],
  instances: { [VID_KEY]: { module_type: 'source.video.file', state: {} } },
};

engine.ready.then(async () => {
  await engine.showSketch('vidsketch', sketch, { bundles: ['com.nano.core'], traceId: 'mon' });
  status.textContent = 'ready (no frame → transparent)';
});

function injectColor(name: 'red' | 'green') {
  const cv = new OffscreenCanvas(W, H);
  const x = cv.getContext('2d')!;
  x.fillStyle = name === 'red' ? 'rgb(255,0,0)' : 'rgb(0,255,0)';
  x.fillRect(0, 0, W, H);
  engine.setInstanceTexture(VID_KEY, cv.transferToImageBitmap());
}

// Decode the real DXV test video through the production VideoCompositor and feed
// the VID_KEY instance (exercises the full decode → blit → inject path).
const compositor = new VideoCompositor(
  (key, bmp) => engine.setInstanceTexture(key, bmp),
  W, H,
  () => ({ beat: (frames * 0.05) % 8, bpm: 120 }), // a slowly advancing fake clock
);
// Decode a media URL through the production VideoCompositor and feed VID_KEY.
function loadVideo(url: string, sourceKey: string, durationFrames: number) {
  compositor.setActiveClips([{
    clipId: 'tb', instanceKey: VID_KEY, url,
    sourceKey, startBeat: 0, lengthBeat: 8, durationFrames,
  }]);
  status.textContent = `loading ${url}…`;
}
const loadDxv = () => loadVideo('/media/test_dxv.mov', 'tb-dxv', 57);
const loadH264 = () => loadVideo('/media/test_h264.mp4', 'tb-h264', 57);

document.getElementById('red')!.addEventListener('click', () => injectColor('red'));
document.getElementById('green')!.addEventListener('click', () => injectColor('green'));
document.getElementById('dxv')!.addEventListener('click', loadDxv);
document.getElementById('h264')!.addEventListener('click', loadH264);

const readCenter = () => {
  const d = ctx.getImageData(W >> 1, H >> 1, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
};

(window as any).__videoTb = {
  engine, compositor, injectColor, loadDxv, loadH264, loadVideo, readCenter,
  get frames() { return frames; },
  videoPumpCount: () => compositor.pumpCount,
  videoLastError: () => compositor.lastError,
  framesInjected: () => compositor.framesInjected,
};
