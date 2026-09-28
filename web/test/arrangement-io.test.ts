/**
 * GPU e2e: clipless layers and Composition I/O routes, on both comp engines.
 *
 * A CLIPLESS layer is a timeline track with no clips whose own sketch is its
 * content (generators included), running continuously. I/O ROUTES carry a
 * track's output (or a named port) into texture fields on other tracks.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-io
 */

import { CENTER, sampleMonitor, waitForMonitor } from './arr-test-helpers';

import { arrangementUrl, forEachCompBackend } from './comp-backend';

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
let URL = '';

/** Reset to N empty timeline tracks (no clips, empty sketches, no routes). */
async function resetTracks(n: number) {
  await page.evaluate((count: number) => {
    const store = (window as any).arrangementStore;
    while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < count) store.addTrack();
    for (const t of store.composition.tracks) {
      if (t.kind !== 'track') continue;
      t.clips = []; t.sketch.devices = []; t.sketch.wires = [];
      t.bypassed = false; t.soloed = false; t.level = undefined; t.blendMode = undefined;
      t.ports = undefined; t.output = undefined;
    }
    store.composition.routes = [];
    store.positionBeat = 16;
  }, n);
}

const centre = async () => (await sampleMonitor(page, [CENTER]))?.[0];

forEachCompBackend(() => {
beforeAll(() => { URL = arrangementUrl(BASE); });

describe('Arrangement clipless layers + I/O routes (GPU)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('a clipless track with a generator renders continuously', async () => {
    await resetTracks(1);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const t = store.composition.tracks.find((x: any) => x.kind === 'track');
      const id = store.insertTrackDeviceAt(t.id, 0, 'source.solid_color');
      store.setTrackDeviceField(t.id, id, 'color', [1, 0, 0]);
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g < 40 && s.b < 40);
    // No clip span to fall out of: far along the timeline it still plays.
    await page.evaluate(() => { (window as any).arrangementStore.positionBeat = 900; });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 200 && s.g < 40);
    const s = await centre();
    expect(s!.r).toBeGreaterThan(200);
  });

  it('an effect-only clipless track processes the stack below it', async () => {
    await resetTracks(2);
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const [top, adj] = store.composition.tracks.filter((x: any) => x.kind === 'track');
      // Top: a black solid clip. Adjustment track: clipless invert → white.
      const path = store.createEmptyClip(top.id, 0, 64);
      const [, t, c] = path.split('/');
      store.addClipDeviceType(t, c, 'source.solid_color');
      const clip = store.composition.tracks.find((x: any) => x.id === t).clips
        .find((x: any) => x.id === c);
      store.setClipDeviceField(t, c, clip.sketch.devices[0].id, 'color', [0, 0, 0]);
      store.insertTrackDeviceAt(adj.id, 0, 'color.invert');
    });
    await waitForMonitor(page, [CENTER], ([s]) => s.r > 220 && s.g > 220 && s.b > 220);
    const s = await centre();
    expect(s!.g).toBeGreaterThan(220);
  });
});
});
