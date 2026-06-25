/**
 * Thumbnail cache testbed boot — Component D harness.
 *
 * Drives the real ThumbnailCache with a procedural producer (simulated decode
 * latency) so the LRU + async-fill + redraw pipeline is verifiable headlessly
 * via window.__thumbs. The real decode path is `VideoThumbnailProducer`.
 */

import { ThumbnailCache, type ThumbnailProducer } from './views/arrangement/media/thumbnail-cache';
import { drawFrameCell, reelSeedFor } from './thumbnail-testbed-frame';

const THUMB_W = 96;
const THUMB_H = 54;
const GAP = 4;
const SLOTS = 16;
const TOTAL = 240; // pretend the clip is 240 frames
const SOURCE = 'demo-clip';
const STEP = Math.floor(TOTAL / SLOTS);

/** Procedural producer: draws a film-reel cell to an ImageBitmap after a delay. */
const procedural: ThumbnailProducer<ImageBitmap> = {
  produce(sourceKey, frame, signal) {
    return new Promise<ImageBitmap>((resolve, reject) => {
      const timer = setTimeout(async () => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const c = document.createElement('canvas');
        c.width = THUMB_W;
        c.height = THUMB_H;
        const ctx = c.getContext('2d')!;
        drawFrameCell(ctx, 0, 0, THUMB_W, THUMB_H, reelSeedFor(sourceKey), frame / TOTAL);
        resolve(await createImageBitmap(c));
      }, 25);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  },
};

const cache = new ThumbnailCache<ImageBitmap>(procedural, {
  capacity: 16,
  dispose: (b) => b.close(),
});

const strip = document.getElementById('strip') as HTMLCanvasElement;
const sctx = strip.getContext('2d', { willReadFrequently: true })!;
const status = document.getElementById('status')!;
let firstFrame = 0;
let drawn = 0;

let raf = 0;
const scheduleRedraw = () => {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; redraw(); });
};
cache.onFill = () => scheduleRedraw();

function frameForSlot(i: number): number {
  return (firstFrame + i * STEP) % TOTAL;
}

function redraw() {
  drawn = 0;
  sctx.clearRect(0, 0, strip.width, strip.height);
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  for (let i = 0; i < SLOTS; i++) {
    const x = i * (THUMB_W + GAP) + GAP;
    const y = GAP;
    const bmp = cache.get(SOURCE, frameForSlot(i));
    if (bmp) {
      sctx.drawImage(bmp, x, y, THUMB_W, THUMB_H);
      drawn++;
    } else {
      sctx.fillStyle = '#22252e';
      sctx.fillRect(x, y, THUMB_W, THUMB_H);
      sctx.fillStyle = '#556';
      sctx.fillText('…', x + THUMB_W / 2, y + THUMB_H / 2);
    }
    sctx.strokeStyle = '#2a2e38';
    sctx.strokeRect(x + 0.5, y + 0.5, THUMB_W, THUMB_H);
  }
  const s = cache.stats();
  status.textContent = `drawn ${drawn}/${SLOTS} · cache ${s.size}/${s.capacity} · inflight ${s.inflight} · hits ${s.hits} · misses ${s.misses}`;
}

function requestStrip() {
  for (let i = 0; i < SLOTS; i++) cache.request(SOURCE, frameForSlot(i));
}

document.getElementById('request')!.addEventListener('click', () => { requestStrip(); scheduleRedraw(); });
document.getElementById('scrub')!.addEventListener('click', () => { firstFrame = (firstFrame + 1) % TOTAL; scheduleRedraw(); });
document.getElementById('clear')!.addEventListener('click', () => { cache.clear(); scheduleRedraw(); });

redraw();

(window as any).__thumbs = {
  cache,
  source: SOURCE,
  slots: SLOTS,
  requestStrip,
  redraw,
  scrub: (n = 1) => { firstFrame = (firstFrame + n) % TOTAL; scheduleRedraw(); },
  stats: () => cache.stats(),
  get drawn() { return drawn; },
  pixelAt(i: number) {
    const x = i * (THUMB_W + GAP) + GAP + THUMB_W / 2;
    const y = GAP + THUMB_H / 2;
    const d = sctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  },
};
