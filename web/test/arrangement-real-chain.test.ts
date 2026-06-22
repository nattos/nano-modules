/**
 * GPU e2e for Component F: REAL clip effect chains. A clip hosts real catalog
 * effects (a generator + an effect); the engine renders the real multi-entry
 * chain, and a real param edit flows back into the engine (re-issued sketch).
 *
 *   clip = [source.noise → color.hsl] renders; editing hsl.lightness re-issues
 *   the sketch to the executor (showCount increases).
 *
 * (Pixel-colour assertions were dropped with the testonly opaque-blue anchor.)
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-real-chain
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

describe('Arrangement real clip chain (GPU)', () => {
  jest.setTimeout(60_000);

  it('renders a real effect chain and a param edit reaches the engine', async () => {
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

    // A real 2-entry chain: noise generator → HSL effect.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 40, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'source.noise');
      store.addClipDeviceType(trackId, clipId, 'color.hsl');
      store.select(path);
      store.positionBeat = 40;
      const clip = store.clipByPath(path).clip;
      const hsl = clip.sketch.devices.find((d: any) => d.moduleType === 'color.hsl');
      return { trackId, clipId, deviceId: hsl.id };
    });

    // The real chain renders.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.hasContent;
      },
      { timeout: 40_000 },
    );
    // Both chain effects were discovered (a real chain, not a fallback).
    const discovered = await page.evaluate(
      () => ((window as any).__engineBridge.discoveredEffects?.() ?? []) as string[],
    );
    expect(discovered).toEqual(expect.arrayContaining(['source.noise', 'color.hsl']));

    // A real param edit re-issues the sketch to the executor.
    const c0 = await page.evaluate(() => (window as any).__engineBridge.showCount() as number);
    await page.evaluate((ids) => {
      (window as any).arrangementStore.setClipDeviceField(ids.trackId, ids.clipId, ids.deviceId, 'lightness', 0.9);
    }, ids);
    await page.waitForFunction(
      (c0) => (window as any).__engineBridge.showCount() > c0,
      { timeout: 20_000 },
      c0,
    );
    expect(await page.evaluate(() => (window as any).__engineBridge.showCount() as number)).toBeGreaterThan(c0);

    expect(errors).toEqual([]);
  });
});
