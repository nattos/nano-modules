/**
 * GPU + transport e2e for the LIVE arrangement app (Components C + E wired in).
 *
 *  - Selecting a clip maps it to a real sketch and renders it through
 *    executor.wasm into the pinned <arr-monitor> (the engine produces frames /
 *    hasContent — not the placeholder).
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

    // A real generator clip (noise) → the engine renders it through executor.wasm.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 40, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'source.noise');
      store.select(path);
      store.positionBeat = 40;
    });

    // Engine boots lazily on first renderable selection; wait for real frames of
    // THIS clip's content (hasContent + frames flowing = not the placeholder).
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.hasContent && b.layerCount() >= 1;
      },
      { timeout: 30_000 },
    );

    // The monitor canvas is being painted (a frame, of any colour, is present).
    const px = await readMonitorCenter();
    expect(px.a).toBeGreaterThan(0);

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
