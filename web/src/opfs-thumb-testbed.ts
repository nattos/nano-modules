/**
 * OPFS thumbnail store testbed boot.
 *
 * Drives WorkerThumbStore (worker + OPFS packs + WebP) end-to-end with real
 * ImageBitmaps. window.__opfsThumb lets Puppeteer assert true persistence:
 * write → flush → reopen (drop in-memory state, re-read from disk) → read back.
 */

import { WorkerThumbStore } from './views/arrangement/media/worker-thumb-store';
import { thumbKey } from './views/arrangement/media/thumbnail-cache';
import { drawFrameCell, reelSeedFor } from './views/arrangement/surfaces/film-reel';

const THUMB_W = 96;
const THUMB_H = 54;
const SOURCE = 'opfs-demo';
const FRAMES = [0, 4, 8, 12, 16, 20, 24, 28];

const store = new WorkerThumbStore();
const canvas = document.getElementById('strip') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const status = document.getElementById('status')!;

async function makeBitmap(frame: number): Promise<ImageBitmap> {
  const c = document.createElement('canvas');
  c.width = THUMB_W; c.height = THUMB_H;
  const cx = c.getContext('2d')!;
  drawFrameCell(cx, 0, 0, THUMB_W, THUMB_H, reelSeedFor(SOURCE), frame / 32);
  return createImageBitmap(c);
}

async function writeStrip() {
  for (const f of FRAMES) {
    const bmp = await makeBitmap(f);
    await store.write(thumbKey(SOURCE, f), bmp);
    bmp.close();
  }
  await store.flush();
  status.textContent = `wrote ${FRAMES.length} tiles to OPFS`;
}

let drawn = 0;
async function readStrip() {
  drawn = 0;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < FRAMES.length; i++) {
    const bmp = await store.read(thumbKey(SOURCE, FRAMES[i]));
    const x = i * (THUMB_W + 4) + 4;
    if (bmp) {
      ctx.drawImage(bmp, x, 4, THUMB_W, THUMB_H);
      bmp.close();
      drawn++;
    } else {
      ctx.fillStyle = '#22252e';
      ctx.fillRect(x, 4, THUMB_W, THUMB_H);
    }
    ctx.strokeStyle = '#2a2e38';
    ctx.strokeRect(x + 0.5, 4.5, THUMB_W, THUMB_H);
  }
  status.textContent = `read ${drawn}/${FRAMES.length} from OPFS`;
}

document.getElementById('write')!.addEventListener('click', () => void writeStrip());
document.getElementById('read')!.addEventListener('click', () => void readStrip());
document.getElementById('reopen')!.addEventListener('click', async () => { await store.reopen(); status.textContent = 'reopened (in-memory state dropped)'; });
document.getElementById('clear')!.addEventListener('click', async () => { await store.clear(); ctx.clearRect(0, 0, canvas.width, canvas.height); status.textContent = 'cleared OPFS'; });

(window as any).__opfsThumb = {
  store,
  source: SOURCE,
  frames: FRAMES,
  writeStrip,
  readStrip,
  reopen: () => store.reopen(),
  clear: () => store.clear(),
  has: (f: number) => store.has(thumbKey(SOURCE, f)),
  stats: () => store.stats(),
  get drawn() { return drawn; },
  pixelAt: (x: number, y: number) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  },
};
