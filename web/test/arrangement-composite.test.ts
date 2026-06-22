/**
 * GPU e2e: the arrangement boots ONE real engine that composites MULTIPLE tracks
 * at the playhead (not just the selected clip), and bypass/opacity flow through
 * the active layer set end-to-end. Two clips are active at the same beat → two
 * engine layers; bypassing a track drops it; un-bypassing restores it.
 *
 * NOTE: the exact composite DRAW ORDER (downward sum — bottom track on top) and
 * the bypass/solo/opacity math are asserted deterministically in the unit tests
 * (state/composite.test.ts, state/composite-depth.test.ts). A pixel-colour
 * assertion here isn't reliable since dropping the testonly bundle removed the
 * one opaque solid stand-in; core's solid_color renders with low alpha.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-composite
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const layerCount = () => page.evaluate(() => (window as any).__engineBridge.layerCount() as number);

describe('Arrangement multi-track compositing (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('boots one engine with two composited layers; bypass drops/restores a layer', async () => {
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

    // A clear beat (fake clips end by 32). Two real generator clips on two tracks.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
      const top = tracks[0].id, bot = tracks[1].id;
      const mk = (trackId: string) => {
        const path = store.createEmptyClip(trackId, 40, 8);
        const [, tId, cId] = path.split('/');
        store.addClipDeviceType(tId, cId, 'source.noise');
        return cId;
      };
      mk(top);
      mk(bot);
      store.positionBeat = 40;
      return { top, bot };
    });

    // Both layers active and the engine is producing frames.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.layerCount() === 2;
      },
      { timeout: 30_000 },
    );
    expect(await layerCount()).toBe(2);

    // Bypass the bottom track → it drops out of the composite.
    await page.evaluate((d) => (window as any).arrangementStore.toggleBypass(d.bot), ids);
    await page.waitForFunction(() => (window as any).__engineBridge.layerCount() === 1, { timeout: 10_000 });
    expect(await layerCount()).toBe(1);

    // Un-bypass → back to two layers (then fade it via opacity, still composited).
    await page.evaluate((d) => {
      const s = (window as any).arrangementStore;
      s.toggleBypass(d.bot);
      s.setTrackLevel(d.bot, 0.5);
    }, ids);
    await page.waitForFunction(() => (window as any).__engineBridge.layerCount() === 2, { timeout: 10_000 });
    expect(await layerCount()).toBe(2);

    expect(errors).toEqual([]);
  });
});
