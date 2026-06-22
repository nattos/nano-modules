/**
 * GPU e2e for Component D wired into the live app: a video clip backed by REAL
 * on-disk media shows DECODED thumbnails in its film strip (not the procedural
 * stand-in). Exercises the whole file-source path in the running arrangement:
 *
 *   addVideoClip → arr-clip.drawRealReel → ThumbnailController (lazy GPU device
 *   + VideoPlaybackService DXV decode → readback → ImageBitmap) → Thumbnail
 *   manager (tiered + views + peek) → WorkerThumbStore (OPFS) → strip repaint.
 *
 * Media: /media/test_dxv.mov (DXV, 1280×720, 57 frames) — DXV is random
 * access so it decodes headlessly. Needs WebGPU (jest-puppeteer config):
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-thumbnails
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const MEDIA_URL = '/media/test_dxv.mov';
const SOURCE_KEY = 'arr-media:test_dxv';
const FRAME_COUNT = 57;

describe('Arrangement film-strip thumbnails (GPU, real media)', () => {
  jest.setTimeout(90_000);

  it('decodes real video frames into the clip film strip', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (t.includes('Failed to load resource')) return;
      errors.push(`[console] ${t}`);
    });

    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!(window as any).__thumbCtl,
      { timeout: 20_000 },
    );

    // Add a video clip backed by the real media and select it.
    const clipId = await page.evaluate(
      (media) => {
        const store = (window as any).arrangementStore;
        const track = store.composition.tracks.find((t: any) => t.kind === 'track');
        const path = store.addVideoClip(track.id, 0, {
          sourceKey: media.sourceKey,
          url: media.url,
          frameCount: media.frameCount,
          fps: 30,
          label: 'Sample',
        }, 12);
        return path.split('/')[2];
      },
      { sourceKey: SOURCE_KEY, url: MEDIA_URL, frameCount: FRAME_COUNT },
    );

    // Find the clip's film-strip canvas (deep shadow-DOM walk).
    await page.waitForFunction(
      (id) => {
        const find = (clipId: string) => {
          const stack: any[] = [document];
          while (stack.length) {
            const node = stack.pop();
            const kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
            for (const el of kids) {
              if (el.tagName === 'ARR-CLIP' && el.clip?.id === clipId) return el;
              if (el.shadowRoot) stack.push(el.shadowRoot);
            }
          }
          return null;
        };
        const el = find(id);
        const c = el?.shadowRoot?.querySelector('.body.reel canvas');
        return !!(c && c.clientWidth > 0);
      },
      { timeout: 20_000 },
      clipId,
    );

    // Wait until the first cell's exact tile decodes + caches (full pipeline).
    const probe = await page.waitForFunction(
      (id, sourceKey) => {
        const find = (clipId: string) => {
          const stack: any[] = [document];
          while (stack.length) {
            const node = stack.pop();
            const kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
            for (const el of kids) {
              if (el.tagName === 'ARR-CLIP' && el.clip?.id === clipId) return el;
              if (el.shadowRoot) stack.push(el.shadowRoot);
            }
          }
          return null;
        };
        const el = find(id);
        const canvas = el?.shadowRoot?.querySelector('.body.reel canvas') as HTMLCanvasElement;
        if (!canvas) return false;
        const ctl = (window as any).__thumbCtl;
        const lay = (window as any).__reelLayout(canvas.clientWidth, canvas.clientHeight, 57);
        if (!lay.cells) return false;
        const hit = ctl.peek(sourceKey, lay.frames[0], lay.level);
        if (!hit) return false;
        return { width: hit.value.width, height: hit.value.height, frame0: lay.frames[0], level: lay.level };
      },
      { timeout: 60_000 },
      clipId,
      SOURCE_KEY,
    );
    const hitInfo = await probe.jsonValue();
    expect((hitInfo as any).width).toBeGreaterThan(0);
    expect((hitInfo as any).height).toBeGreaterThan(0);

    // The strip must actually PAINT the decoded tile: cell-0 mean ≈ the peek
    // tile's mean. The procedural fallback would not match the real tile.
    const cmp = await page.evaluate(
      (id, sourceKey) => {
        const find = (clipId: string) => {
          const stack: any[] = [document];
          while (stack.length) {
            const node = stack.pop();
            const kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
            for (const el of kids) {
              if (el.tagName === 'ARR-CLIP' && el.clip?.id === clipId) return el;
              if (el.shadowRoot) stack.push(el.shadowRoot);
            }
          }
          return null;
        };
        const mean = (data: Uint8ClampedArray) => {
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
          return [r / n, g / n, b / n];
        };
        const el = find(id) as any;
        const canvas = el.shadowRoot.querySelector('.body.reel canvas') as HTMLCanvasElement;
        const ctl = (window as any).__thumbCtl;
        const lay = (window as any).__reelLayout(canvas.clientWidth, canvas.clientHeight, 57);
        const hit = ctl.peek(sourceKey, lay.frames[0], lay.level);

        // Cell-0 region mean from the strip canvas.
        const cctx = canvas.getContext('2d')!;
        const step = Math.floor(canvas.width / lay.cells);
        const cell = cctx.getImageData(0, 0, Math.max(1, step - 2), canvas.height);
        const cellMean = mean(cell.data);

        // The peek tile's mean (draw to an offscreen canvas to read pixels).
        const off = document.createElement('canvas');
        off.width = hit.value.width; off.height = hit.value.height;
        const octx = off.getContext('2d')!;
        octx.drawImage(hit.value, 0, 0);
        const tileMean = mean(octx.getImageData(0, 0, off.width, off.height).data);

        return { cellMean, tileMean };
      },
      clipId,
      SOURCE_KEY,
    );

    const d =
      Math.abs(cmp.cellMean[0] - cmp.tileMean[0]) +
      Math.abs(cmp.cellMean[1] - cmp.tileMean[1]) +
      Math.abs(cmp.cellMean[2] - cmp.tileMean[2]);
    expect(d).toBeLessThan(45); // strip cell shows the real decoded tile

    expect((await page.evaluate(() => (window as any).__thumbCtl.tilesFilled))).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
