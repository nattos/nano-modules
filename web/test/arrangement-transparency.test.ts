/**
 * GPU e2e: a SOURCE clip with transparency composites OVER the track below it
 * (revealing it where the clip is transparent), instead of baking the transparent
 * regions to opaque black. Bottom track (drawn on top, downward sum) = a source
 * clip [noise → crop] cropped to the centre (transparent outside); top track =
 * noise. Outside the crop the composite must reveal the top track's noise
 * (spatially varied), not a flat black fill.
 *
 * This exercises the composite.blend source-over fix (alpha is preserved, the
 * blend doesn't force opaque).
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-transparency
 */

import { lumaSpread, sampleMonitor, waitForMonitor, type UV } from './arr-test-helpers';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Spread of luma over a sub-rectangle of the monitor (fx0..fx1, fy0..fy1). */
const regionUVs = (fx0: number, fy0: number, fx1: number, fy1: number): UV[] => {
  const out: UV[] = [];
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) out.push([fx0 + ((fx1 - fx0) * i) / 4, fy0 + ((fy1 - fy0) * j) / 4]);
  return out;
};
const regionSpread = async (fx0: number, fy0: number, fx1: number, fy1: number) =>
  lumaSpread((await sampleMonitor(page, regionUVs(fx0, fy0, fx1, fy1))) ?? []);

describe('Arrangement source-clip transparency (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('a cropped source clip reveals the track below outside the crop', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      // Boot is an empty doc with one starter track — ensure two empty tracks.
      while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < 2) store.addTrack();
      const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
      // Top track: a noise background.
      let path = store.createEmptyClip(tracks[0].id, 40, 8);
      let a = path.split('/');
      store.addClipDeviceType(a[1], a[2], 'source.noise');
      // Track below: a source clip cropped to the centre → transparent outside.
      path = store.createEmptyClip(tracks[1].id, 40, 8);
      a = path.split('/');
      store.addClipDeviceType(a[1], a[2], 'source.noise');
      store.addClipDeviceType(a[1], a[2], 'warp.crop');
      const cr = store.clipByPath(path).clip.sketch.devices.find((d: any) => d.moduleType === 'warp.crop');
      // `mode` MUST be Inset (1) FIRST. warp.crop defaults to Span, whose own
      // defaults (centre 0, width/height 1) keep the whole frame — so setting
      // only the four insets crops NOTHING, the clip stays fully opaque, and
      // the assertion below passes on the clip's own noise instead of the
      // track below it. (Caught by the dual-backend port of this suite, which
      // reads raw pixels: `arrangement-transparency-parity.test.ts`.)
      store.setClipDeviceField(a[1], a[2], cr.id, 'mode', 1);
      for (const k of ['inset_left', 'inset_right', 'inset_top', 'inset_bottom']) {
        store.setClipDeviceField(a[1], a[2], cr.id, k, 0.45);
      }
      store.positionBeat = 40;
    });

    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 5 && b.layerCount() === 2;
      },
      { timeout: 30_000 },
    );

    // The top-left quadrant is OUTSIDE the centre crop, so it shows the track
    // below (noise → spatially varied). The old blend baked it to opaque black
    // (spread ≈ 0).
    await waitForMonitor(page, regionUVs(0, 0, 0.25, 0.25), (s) => lumaSpread(s) > 4);
    // Corner (outside crop) reveals the varied track below — not flat black.
    expect(await regionSpread(0, 0, 0.25, 0.25)).toBeGreaterThan(4);

    expect(errors.filter((e) => /DataClone/.test(e))).toEqual([]);
  });
});
