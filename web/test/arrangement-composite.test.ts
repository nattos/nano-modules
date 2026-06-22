/**
 * GPU e2e: the monitor composites MULTIPLE tracks at the playhead (not just the
 * selected clip). Two effect tracks each hold a clip active at the same beat;
 * the top track draws over the bottom, and bypassing the top reveals the bottom
 * — proving both layers render and the composite order is correct.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-composite
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const center = () =>
  page.evaluate(() => {
    const app = document.querySelector('arrangement-app') as any;
    const canvas = app?.shadowRoot
      ?.querySelector('arr-monitor')
      ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  });

const isBlue = (p: { r: number; g: number; b: number }) =>
  Math.abs(p.r - 0) < 24 && Math.abs(p.g - 128) < 28 && Math.abs(p.b - 255) < 24;

describe('Arrangement multi-track compositing (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('composites two tracks; top covers bottom; bypass top reveals bottom', async () => {
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

    // A clear beat (fake clips end by 32). Top track (1st 'track') gets an
    // identity-HSL clip (solid blue); bottom track gets an HSL hue-shifted clip
    // (non-blue). Both active at beat 40.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
      const top = tracks[0].id, bot = tracks[1].id;

      const mk = (trackId: string, hue: number) => {
        const path = store.createEmptyClip(trackId, 40, 8);
        const [, tId, cId] = path.split('/');
        store.addClipDeviceType(tId, cId, 'color.hsl');
        const dev = store.clipByPath(path).clip.sketch.devices[0];
        if (hue) store.setClipDeviceField(tId, cId, dev.id, 'hue_shift', hue);
        return cId;
      };
      mk(top, 0);    // top: blue
      mk(bot, 0.45); // bottom: hue-shifted (non-blue)
      store.positionBeat = 40;
      return { top, bot };
    });

    // Engine boots; both layers active.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.layerCount() === 2;
      },
      { timeout: 30_000 },
    );

    // Top (blue) draws over the bottom → center is blue.
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const canvas = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        if (!canvas) return false;
        const d = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return Math.abs(d[0]) < 24 && Math.abs(d[1] - 128) < 28 && Math.abs(d[2] - 255) < 24;
      },
      { timeout: 30_000 },
    );
    const composed = await center();
    expect(isBlue(composed)).toBe(true);

    // Bypass the top track → the bottom (non-blue) layer shows through.
    await page.evaluate((d) => (window as any).arrangementStore.toggleBypass(d.top), ids);
    await page.waitForFunction(
      () => (window as any).__engineBridge.layerCount() === 1,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const canvas = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        const d = canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        // No longer blue (the bottom hue-shifted layer is now on top).
        return !(Math.abs(d[0]) < 24 && Math.abs(d[1] - 128) < 28 && Math.abs(d[2] - 255) < 24);
      },
      { timeout: 30_000 },
    );
    const bottomOnly = await center();
    expect(isBlue(bottomOnly)).toBe(false);

    // OPACITY: un-bypass the top, then drive its level to 0 → it's drawn fully
    // transparent so the bottom shows through; level 1 brings the blue back.
    await page.evaluate((d) => {
      const s = (window as any).arrangementStore;
      s.toggleBypass(d.top); // restore (2 layers again)
      s.setTrackLevel(d.top, 0);
    }, ids);
    await page.waitForFunction(() => (window as any).__engineBridge.layerCount() === 2, { timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const c = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return !(Math.abs(d[0]) < 24 && Math.abs(d[1] - 128) < 28 && Math.abs(d[2] - 255) < 24); // not blue
      },
      { timeout: 30_000 },
    );
    expect(isBlue(await center())).toBe(false); // transparent top → bottom shows

    await page.evaluate((d) => (window as any).arrangementStore.setTrackLevel(d.top, 1), ids);
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const c = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return Math.abs(d[0]) < 24 && Math.abs(d[1] - 128) < 28 && Math.abs(d[2] - 255) < 24; // blue again
      },
      { timeout: 30_000 },
    );
    expect(isBlue(await center())).toBe(true); // opaque top → blue

    expect(errors).toEqual([]);
  });
});
