/**
 * Thumbnail mip / persistence testbed boot.
 *
 * Exercises the full tiered, zoom-aware system end-to-end with REAL ImageBitmaps
 * (through the ImageData codec + mock disk store), which the string-typed unit
 * tests can't cover. window.__thumbMip drives it for headless assertions.
 */

import { ThumbnailManager } from './views/arrangement/media/thumbnail-manager';
import { MockThumbStore } from './views/arrangement/media/thumbnail-store';
import type { ThumbCodec } from './views/arrangement/media/thumbnail-store';
import type { ThumbnailProducer } from './views/arrangement/media/thumbnail-cache';
import {
  levelForFramesPerThumb,
  strideForLevel,
  framesInRange,
} from './views/arrangement/media/thumbnail-mip';
import { drawFrameCell, reelSeedFor } from './thumbnail-testbed-frame';

const THUMB_W = 96;
const THUMB_H = 54;
const TOTAL = 480;
const SOURCE = 'clip';

// Procedural decoder (stands in for VideoThumbnailProducer), with latency.
const decoder: ThumbnailProducer<ImageBitmap> = {
  produce(sourceKey, frame, signal) {
    return new Promise<ImageBitmap>((resolve, reject) => {
      const t = setTimeout(async () => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const c = document.createElement('canvas');
        c.width = THUMB_W; c.height = THUMB_H;
        const ctx = c.getContext('2d')!;
        drawFrameCell(ctx, 0, 0, THUMB_W, THUMB_H, reelSeedFor(sourceKey), frame / TOTAL);
        resolve(await createImageBitmap(c));
      }, 8);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
    });
  },
};

// Codec: live ImageBitmap ⇄ serialized ImageData (the disk tier holds the latter
// so the hot tier can close bitmaps on eviction without corrupting the store).
const codec: ThumbCodec<ImageBitmap, ImageData> = {
  async encode(bmp) {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  },
  async decode(img) { return createImageBitmap(img); },
};

const store = new MockThumbStore<ImageData>({ latencyMs: 0 });
const mgr = new ThumbnailManager<ImageBitmap, ImageData>(decoder, store, codec, {
  baseCapacity: 64,
  dispose: (b) => b.close(),
});

const canvas = document.getElementById('strip') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const status = document.getElementById('status')!;

let pxPerFrame = 4;
let scrollFrame = 0;
let drawnExact = 0;
let drawnStretched = 0;

const level = () => levelForFramesPerThumb(THUMB_W / pxPerFrame);
const visibleEnd = () => scrollFrame + canvas.width / pxPerFrame;

function updateView() {
  const L = level();
  mgr.setView('strip', {
    sourceKey: SOURCE,
    level: L,
    startFrame: Math.max(0, scrollFrame),
    endFrame: Math.min(TOTAL, visibleEnd()),
    pattern: 'window',
    readaheadFrames: strideForLevel(L) * 4,
  });
}

let raf = 0;
const scheduleRedraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
mgr.onChange = () => scheduleRedraw();

function draw() {
  const L = level();
  const stride = strideForLevel(L);
  const w = stride * pxPerFrame;
  drawnExact = 0;
  drawnStretched = 0;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const f of framesInRange(scrollFrame, visibleEnd(), L)) {
    const hit = mgr.peek(SOURCE, f, L);
    const x = ((hit ? hit.frame : f) - scrollFrame) * pxPerFrame;
    if (hit) {
      ctx.drawImage(hit.value, x, 4, w, THUMB_H);
      if (hit.exact) drawnExact++; else drawnStretched++;
    } else {
      ctx.fillStyle = '#22252e';
      ctx.fillRect(x, 4, w, THUMB_H);
      ctx.fillStyle = '#556';
      ctx.fillText('…', x + w / 2, 4 + THUMB_H / 2);
    }
    ctx.strokeStyle = '#2a2e38';
    ctx.strokeRect(x + 0.5, 4.5, w, THUMB_H);
  }

  const s = mgr.stats();
  status.textContent =
    `level ${L} (stride ${stride}) · exact ${drawnExact} stretched ${drawnStretched} · ` +
    `mem ${s.memory.size} · disk ${s.store} · decodes ${s.decodes} · reads ${store.reads} writes ${store.writes}`;
}

(document.getElementById('zoom') as HTMLInputElement).addEventListener('input', (e) => {
  pxPerFrame = Number((e.target as HTMLInputElement).value);
  updateView();
  scheduleRedraw();
});
(document.getElementById('scroll') as HTMLInputElement).addEventListener('input', (e) => {
  scrollFrame = Number((e.target as HTMLInputElement).value);
  updateView();
  scheduleRedraw();
});
document.getElementById('cold')!.addEventListener('click', () => {
  mgr.clearMemory();
  updateView();
  scheduleRedraw();
});

updateView();
draw();

(window as any).__thumbMip = {
  manager: mgr,
  store,
  level,
  prewarm: () => updateView(),
  redraw: draw,
  coldStart: () => { mgr.clearMemory(); updateView(); },
  setZoom: (ppf: number) => { pxPerFrame = ppf; updateView(); scheduleRedraw(); },
  visibleTileCount: () => framesInRange(scrollFrame, visibleEnd(), level()).length,
  get drawnExact() { return drawnExact; },
  get drawnStretched() { return drawnStretched; },
  stats: () => ({ ...mgr.stats(), reads: store.reads, writes: store.writes }),
  pixelAt: (x: number, y: number) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  },
};
