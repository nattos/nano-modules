/**
 * GPU e2e: an effect clip processes the COMPOSITE OF THE TRACKS ABOVE IT, not an
 * isolated gray stand-in. Top track = a noise generator (spatially varied); the
 * track below it = a single `color.invert` effect clip. The combined-chain
 * compositor feeds the noise into the invert, so the output stays spatially
 * varied (invert of noise). The OLD per-clip design rendered the invert on its
 * own gray anchor → a flat fill that covered the noise (spread ≈ 0).
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-layer-pipeline
 */

import { interiorGridUVs, lumaSpread, sampleMonitor, waitForMonitor } from './arr-test-helpers';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const GRID = interiorGridUVs(6);
const spread = async () => lumaSpread((await sampleMonitor(page, GRID)) ?? []);

describe('Arrangement layer pipeline (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('an effect clip processes the track above it (not a gray stand-in)', async () => {
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

    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      // Boot is an empty doc with one starter track — ensure two empty tracks.
      while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < 2) store.addTrack();
      const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
      // Top track: a noise generator (spatially varied).
      let path = store.createEmptyClip(tracks[0].id, 40, 8);
      let [, t, c] = path.split('/');
      store.addClipDeviceType(t, c, 'source.noise');
      // Track below: a single effect-only clip (invert).
      path = store.createEmptyClip(tracks[1].id, 40, 8);
      [, t, c] = path.split('/');
      store.addClipDeviceType(t, c, 'color.invert');
      store.positionBeat = 40;
    });

    // Both engine layers fold into one combined chain.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.hasContent && b.layerCount() === 2;
      },
      { timeout: 30_000 },
    );

    // The composite stays spatially varied → the invert processed the noise from
    // the track above (a gray stand-in would be a flat fill, spread ≈ 0).
    await waitForMonitor(page, GRID, (s) => lumaSpread(s) > 8);
    expect(await spread()).toBeGreaterThan(8);

    expect(errors).toEqual([]);
  });
});
