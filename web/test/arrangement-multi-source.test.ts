/**
 * GPU e2e: MORE THAN ONE SOURCE renders — both across tracks and within one clip.
 *
 * The composite build used to keep only a clip's FIRST generator and drop every
 * later one, so adding a second source.text.plain to a clip did nothing (the card
 * showed in the inspector, the text never appeared). Two source clips on separate
 * tracks are a different path (two layers) and must both show too.
 *
 * The probe is spatial: each text sits at a different `v_pos`, so "did it render"
 * = "is there ink in that horizontal band". Ink is matched by COLOUR (not alpha —
 * traced frames are checkerboard-composited, so alpha is always 255), and each
 * case uses its OWN ink colour: with nothing active the monitor simply stops
 * updating rather than clearing, so a colour the previous case never drew is what
 * makes "this case rendered" unambiguous.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-multi-source
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const TEXT = 'source.text.plain';
/** Bands (fractions of height) the two texts are anchored in. */
const TOP_VPOS = 0.2;
const BOTTOM_VPOS = 0.8;

type Ink = 'white' | 'red' | 'green';
/** Per-case ink colour (see the header): rgba + the matching pixel predicate. */
const INK: Record<Ink, { rgba: number[]; hit: string }> = {
  white: { rgba: [1, 1, 1, 1], hit: 'r > 200 && g > 200 && b > 200' },
  red:   { rgba: [1, 0, 0, 1], hit: 'r > 170 && g < 90 && b < 90' },
  green: { rgba: [0, 1, 0, 1], hit: 'g > 170 && r < 90 && b < 90' },
};

/** Matching-ink pixel counts in the upper and lower thirds of the monitor. */
const bandInk = (ink: Ink) =>
  page.evaluate((hitSrc: string) => {
    const app = document.querySelector('arrangement-app') as any;
    const canvas = app?.shadowRoot
      ?.querySelector('arr-monitor')
      ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    if (!canvas || !canvas.width) return null;
    const ctx = canvas.getContext('2d')!;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // eslint-disable-next-line no-new-func
    const hit = new Function('r', 'g', 'b', `return ${hitSrc};`) as
      (r: number, g: number, b: number) => boolean;
    let top = 0;
    let bottom = 0;
    const third = canvas.height / 3;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (!hit(d[i], d[i + 1], d[i + 2])) continue;
        if (y < third) top++;
        else if (y > canvas.height - third) bottom++;
      }
    }
    return { top, bottom, w: canvas.width, h: canvas.height };
  }, INK[ink].hit);

/** Wait until BOTH bands carry this case's ink (the engine needs a few frames). */
async function waitForBothBands(ink: Ink): Promise<{ top: number; bottom: number }> {
  let last: unknown = null;
  for (let i = 0; i < 80; i++) {
    const k = await bandInk(ink);
    if (k) {
      last = k;
      if (k.top > 20 && k.bottom > 20) return k;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`only one ${ink} band ever rendered — last sample ${JSON.stringify(last)}`);
}

describe('Arrangement renders MULTIPLE sources (GPU)', () => {
  jest.setTimeout(150_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    // The text bundle must be discovered before a clip can reference it.
    await page.waitForFunction(
      (id: string) => !!(window as any).arrangementStore.enginePlugin(id),
      { timeout: 40_000 },
      TEXT,
    );
  });

  it('two source.text.plain clips on SEPARATE tracks both render', async () => {
    await page.evaluate((cfg) => {
      const store = (window as any).arrangementStore;
      const mk = (text: string, vPos: number) => {
        const trackId = store.addTrack();
        const [, tId, cId] = store.createEmptyClip(trackId, cfg.beat, 16).split('/');
        store.addClipDeviceType(tId, cId, cfg.TEXT);
        const dev = store.clipByPath(`clip/${tId}/${cId}`).clip.sketch.devices[0];
        store.setClipDeviceField(tId, cId, dev.id, 'text', text);
        store.setClipDeviceField(tId, cId, dev.id, 'size', 110);
        store.setClipDeviceField(tId, cId, dev.id, 'v_pos', vPos);
        store.setClipDeviceField(tId, cId, dev.id, 'color', cfg.rgba);
      };
      mk('TOP', cfg.TOP_VPOS);
      mk('BOTTOM', cfg.BOTTOM_VPOS);
      store.setPlayFrom(cfg.beat + 4);
    }, { TEXT, TOP_VPOS, BOTTOM_VPOS, beat: 200, rgba: INK.red.rgba });

    const k = await waitForBothBands('red');
    expect(k.top).toBeGreaterThan(20);
    expect(k.bottom).toBeGreaterThan(20);
  });

  it('two source.text.plain devices in ONE clip both render', async () => {
    await page.evaluate((cfg) => {
      const store = (window as any).arrangementStore;
      const trackId = store.addTrack();
      const [, tId, cId] = store.createEmptyClip(trackId, cfg.beat, 16).split('/');
      store.addClipDeviceType(tId, cId, cfg.TEXT);
      store.addClipDeviceType(tId, cId, cfg.TEXT);
      const devs = store.clipByPath(`clip/${tId}/${cId}`).clip.sketch.devices;
      const set = (devId: string, text: string, vPos: number) => {
        store.setClipDeviceField(tId, cId, devId, 'text', text);
        store.setClipDeviceField(tId, cId, devId, 'size', 110);
        store.setClipDeviceField(tId, cId, devId, 'v_pos', vPos);
        store.setClipDeviceField(tId, cId, devId, 'color', cfg.rgba);
      };
      set(devs[0].id, 'TOP', cfg.TOP_VPOS);
      set(devs[1].id, 'BOTTOM', cfg.BOTTOM_VPOS);
      store.setPlayFrom(cfg.beat + 4);
    }, { TEXT, TOP_VPOS, BOTTOM_VPOS, beat: 300, rgba: INK.green.rgba });

    const k = await waitForBothBands('green');
    expect(k.top).toBeGreaterThan(20);
    expect(k.bottom).toBeGreaterThan(20);
  });
});
