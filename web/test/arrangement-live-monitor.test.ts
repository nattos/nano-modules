/**
 * GPU + transport e2e for the LIVE arrangement app (Components C + E wired in).
 *
 *  - Selecting a clip maps it to a real sketch and renders it through
 *    executor.wasm into the pinned <arr-monitor> (not the placeholder). An
 *    effect clip maps to the deterministic solid (0,128,255) for a pixel check.
 *  - Pressing play advances the warped transport playhead (positionBeat).
 *
 * Needs a dev server with WebGPU (jest-puppeteer config enables it):
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-live-monitor
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

describe('Arrangement live monitor + transport (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  const readMonitorCenter = () =>
    page.evaluate(() => {
      const app = document.querySelector('arrangement-app') as any;
      const mon = app?.shadowRoot?.querySelector('arr-monitor') as any;
      const canvas = mon?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const x = Math.floor(canvas.width / 2);
      const y = Math.floor(canvas.height / 2);
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    });

  it('renders the selected clip into the monitor through the real executor', async () => {
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

    // Create a real effect clip: implicit gpu_test anchor (solid blue) → identity
    // HSL chain → still blue. Exercises the real clip chain deterministically.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 0, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'color.hsl'); // identity defaults
      store.select(path);
    });

    // Engine boots lazily on first renderable selection; wait for real frames.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.hasContent;
      },
      { timeout: 30_000 },
    );

    // Poll until the monitor actually shows the solid scene (frame painted).
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const canvas = app?.shadowRoot
          ?.querySelector('arr-monitor')
          ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        if (!canvas) return false;
        const ctx = canvas.getContext('2d')!;
        const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return Math.abs(d[0] - 0) < 24 && Math.abs(d[1] - 128) < 28 && Math.abs(d[2] - 255) < 24;
      },
      { timeout: 30_000 },
    );

    const px = await readMonitorCenter();
    expect(Math.abs(px.r - 0)).toBeLessThan(24);
    expect(Math.abs(px.g - 128)).toBeLessThan(28);
    expect(Math.abs(px.b - 255)).toBeLessThan(24);

    expect(errors).toEqual([]);
  });

  it('advances the warped transport playhead on play', async () => {
    const advanced = await page.evaluate(async () => {
      const store = (window as any).arrangementStore;
      store.setPlayFrom(0);
      const before = store.positionBeat;
      store.togglePlay();
      await new Promise((r) => setTimeout(r, 400));
      const after = store.positionBeat;
      store.stop();
      return { before, after };
    });
    expect(advanced.before).toBeCloseTo(0, 5);
    expect(advanced.after).toBeGreaterThan(0.05); // ~0.4s of playback advanced beats
  });
});
