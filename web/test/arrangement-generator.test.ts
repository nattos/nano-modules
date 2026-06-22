/**
 * GPU e2e: a CORE generator renders in the arrangement (testonly is no longer
 * loaded — the catalog now mounts the production core/nano/lights bundles).
 *
 * Validates: (1) the dev server's core bundle exposes `source.noise`, and (2) the
 * arrangement catalog entry builds a real chain that renders. Asserts spatial
 * structure (animated noise is non-uniform, unlike the solid-color stand-in) and
 * animation over time.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-generator
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const GENERATOR = 'source.noise';

/** Sample a coarse grid and report spread (non-uniformity) of luma. */
const sampleScene = () =>
  page.evaluate(() => {
    const app = document.querySelector('arrangement-app') as any;
    const canvas = app?.shadowRoot
      ?.querySelector('arr-monitor')
      ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d')!;
    const lumas: number[] = [];
    const N = 6;
    for (let iy = 1; iy < N; iy++) {
      for (let ix = 1; ix < N; ix++) {
        const x = Math.floor((canvas.width * ix) / N);
        const y = Math.floor((canvas.height * iy) / N);
        const d = ctx.getImageData(x, y, 1, 1).data;
        lumas.push(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
      }
    }
    const min = Math.min(...lumas);
    const max = Math.max(...lumas);
    return { spread: max - min, sig: lumas.map((l) => Math.round(l)).join(',') };
  });

describe('Arrangement renders a core generator (testonly dropped)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('discovers + renders the core generator (non-uniform, animated)', async () => {
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

    // A clip whose sole device is a core generator → it IS the source.
    await page.evaluate((gen) => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 0, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, gen);
      store.select(path);
    }, GENERATOR);

    // Engine boots lazily; wait for real frames of THIS clip's content.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.hasContent;
      },
      { timeout: 30_000 },
    );

    // The effect must be discovered under its core id (else the chain is empty).
    const discovered = await page.evaluate(() =>
      ((window as any).__engineBridge?.discoveredEffects?.() ?? []) as string[]);
    expect(discovered).toContain(GENERATOR);

    // Scene structure: animated noise is spatially non-uniform.
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const canvas = app?.shadowRoot
          ?.querySelector('arr-monitor')
          ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        if (!canvas) return false;
        const ctx = canvas.getContext('2d')!;
        const ls: number[] = [];
        for (let i = 1; i < 6; i++) {
          const x = Math.floor((canvas.width * i) / 6);
          const y = Math.floor((canvas.height * i) / 6);
          const d = ctx.getImageData(x, y, 1, 1).data;
          ls.push(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
        }
        return Math.max(...ls) - Math.min(...ls) > 8;
      },
      { timeout: 30_000 },
    );

    const a = await sampleScene();
    expect(a).not.toBeNull();
    expect(a!.spread).toBeGreaterThan(8); // structured, not a flat fill

    // Animation: noise evolves at speed 0.5 → the sampled signature changes.
    await new Promise((r) => setTimeout(r, 600));
    const b = await sampleScene();
    expect(b!.sig).not.toEqual(a!.sig);

    expect(errors).toEqual([]);
  });
});
