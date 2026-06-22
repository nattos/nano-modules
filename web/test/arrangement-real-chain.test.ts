/**
 * GPU e2e for Component F: REAL clip effect chains. A clip hosts real effects
 * (from the catalog); the engine renders the real chain and a real param edit
 * visibly changes the output.
 *
 *   effect clip + color.hsl (identity) → implicit gpu_test anchor (blue) stays
 *   blue; then hsl.lightness↑ → the monitor brightens (pixels change).
 *
 * Needs WebGPU (jest-puppeteer config):
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-real-chain
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const readMonitorCenter = () =>
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
  Math.abs(p.r - 0) < 28 && Math.abs(p.g - 128) < 34 && Math.abs(p.b - 255) < 28;

describe('Arrangement real clip chain (GPU)', () => {
  jest.setTimeout(60_000);

  it('renders a real effect chain and reacts to a real param edit', async () => {
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
      () => !!(window as any).arrangementStore && !!(window as any).__engineBridge,
      { timeout: 20_000 },
    );

    // Effect clip with a real HSL effect at identity → blue (gpu_test) passthrough.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 0, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'color.hsl');
      store.select(path);
      const clip = store.clipByPath(path).clip;
      return { trackId, clipId, deviceId: clip.sketch.devices[0].id };
    });

    // Wait for real frames + the identity chain showing blue.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        if (!b?.isBooted || b.framesSeen < 5 || !b.hasContent) return false;
        const app = document.querySelector('arrangement-app') as any;
        const c = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        if (!c) return false;
        const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return Math.abs(d[0]) < 28 && Math.abs(d[1] - 128) < 34 && Math.abs(d[2] - 255) < 28;
      },
      { timeout: 40_000 },
    );
    const before = await readMonitorCenter();
    expect(isBlue(before)).toBe(true);

    // Real param edit: push lightness up → output brightens.
    await page.evaluate((ids) => {
      const store = (window as any).arrangementStore;
      store.setClipDeviceField(ids.trackId, ids.clipId, ids.deviceId, 'lightness', 0.9);
    }, ids);

    await page.waitForFunction(
      (beforeJson) => {
        const before = JSON.parse(beforeJson);
        const app = document.querySelector('arrangement-app') as any;
        const c = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        if (!c) return false;
        const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        const delta = Math.abs(d[0] - before.r) + Math.abs(d[1] - before.g) + Math.abs(d[2] - before.b);
        return delta > 30; // the param visibly changed the rendered output
      },
      { timeout: 20_000 },
      JSON.stringify(before),
    );

    const after = await readMonitorCenter();
    const delta = Math.abs(after.r - before.r) + Math.abs(after.g - before.g) + Math.abs(after.b - before.b);
    expect(delta).toBeGreaterThan(30);

    expect(errors).toEqual([]);
  });
});
