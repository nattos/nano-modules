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

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Spread of luma over a sub-rectangle of the monitor (fx0..fx1, fy0..fy1). */
const regionSpread = (fx0: number, fy0: number, fx1: number, fy1: number) =>
  page.evaluate(
    (a) => {
      const app = document.querySelector('arrangement-app') as any;
      const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const ctx = cv.getContext('2d')!;
      const ls: number[] = [];
      for (let i = 0; i <= 4; i++)
        for (let j = 0; j <= 4; j++) {
          const x = Math.floor(cv.width * (a.fx0 + ((a.fx1 - a.fx0) * i) / 4));
          const y = Math.floor(cv.height * (a.fy0 + ((a.fy1 - a.fy0) * j) / 4));
          const d = ctx.getImageData(x, y, 1, 1).data;
          ls.push(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
        }
      return Math.max(...ls) - Math.min(...ls);
    },
    { fx0, fy0, fx1, fy1 },
  );

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
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        if (!cv) return false;
        const ctx = cv.getContext('2d')!;
        const ls: number[] = [];
        for (let i = 0; i <= 4; i++)
          for (let j = 0; j <= 4; j++) {
            const d = ctx.getImageData(Math.floor((cv.width * i) / 16), Math.floor((cv.height * j) / 16), 1, 1).data;
            ls.push(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
          }
        return Math.max(...ls) - Math.min(...ls) > 4;
      },
      { timeout: 30_000 },
    );
    // Corner (outside crop) reveals the varied track below — not flat black.
    expect(await regionSpread(0, 0, 0.25, 0.25)).toBeGreaterThan(4);

    expect(errors.filter((e) => /DataClone/.test(e))).toEqual([]);
  });
});
