/**
 * GPU e2e for Component F: REAL clip effect chains. A clip hosts real catalog
 * effects (a generator + an effect); the engine renders the real multi-entry
 * chain, and a real param edit flows through the comp executor to the pixels.
 *
 *   clip = [source.noise → color.hsl] renders; editing hsl.lightness to 0.9
 *   visibly brightens the monitor output.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-real-chain
 */

import { luma, sampleMonitor, waitForMonitor, type MonitorSample, type UV } from './arr-test-helpers';

import { arrangementUrl, forEachCompBackend } from './comp-backend';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
let URL = ''; // the live backend's arrangement URL — set per suite (comp-backend.ts)

forEachCompBackend(() => {
beforeAll(() => { URL = arrangementUrl(BASE); });

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

    // A real param edit reaches the engine: the composition executor re-syncs
    // the document mirror (docRev) and the rendered pixels move. lightness 0.9
    // pushes the HSL output toward white — the monitor mean must rise.
    // Five points across the middle row.
    const ROW: UV[] = [0, 1, 2, 3, 4].map((i) => [(i + 0.5) / 5, 0.5] as UV);
    const mean = (s: MonitorSample[]) => s.reduce((a, p) => a + luma(p), 0) / s.length;
    const before = mean((await sampleMonitor(page, ROW))!);
    await page.evaluate((ids) => {
      (window as any).arrangementStore.setClipDeviceField(ids.trackId, ids.clipId, ids.deviceId, 'lightness', 0.9);
    }, ids);
    await waitForMonitor(page, ROW, (s) => mean(s) > before + 40, { timeout: 20_000 });

    expect(errors).toEqual([]);
  });
});
});
