/**
 * GPU e2e: COMP MODE A/B pixel parity. The same deterministic composition is
 * rendered twice — once through the legacy TS build-and-push path, once with
 * the in-wasm composition executor (`?compMode=1`) — and the monitor pixels
 * must match. Byte-equal sketch in ⇒ identical pixels out (same executor), so
 * any drift here means the comp executor's document mirror / tree eval /
 * sketch build diverged from the TS reference at runtime.
 *
 * Scenario: three tracks —
 *   top    = solid_color [0.2, 0.4, 0.8]
 *   middle = solid_color [1, 0, 0], track level 0.5 (composite.blend opacity)
 *   bottom = effect-only clip (color.invert) processing the composite above
 * All time-independent → stable pixels for the A/B comparison.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-comp-mode
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Build the fixture composition in the live store and park the playhead in it. */
const buildScenario = () => page.evaluate(() => {
  const store = (window as any).arrangementStore;
  while (store.composition.tracks.filter((t: any) => t.kind === 'track').length < 3) store.addTrack();
  const tracks = store.composition.tracks.filter((t: any) => t.kind === 'track');
  const mk = (trackId: string, type: string, state?: Record<string, unknown>) => {
    const path = store.createEmptyClip(trackId, 40, 8);
    const [, tId, cId] = path.split('/');
    store.addClipDeviceType(tId, cId, type);
    if (state) {
      const clip = store.trackById(tId).clips.find((c: any) => c.id === cId);
      Object.assign(clip.sketch.devices[0].state ??= {}, state);
      store.docRev++; // direct mutation (test-only) — mirror the doc for comp mode
    }
    return cId;
  };
  mk(tracks[0].id, 'source.solid_color', { color: [0.2, 0.4, 0.8] });
  mk(tracks[1].id, 'source.solid_color', { color: [1, 0, 0] });
  tracks[1].level = 0.5;
  mk(tracks[2].id, 'color.invert');
  store.positionBeat = 42;
});

/** 5×5 RGB grid over the monitor canvas. */
const sampleGrid = () => page.evaluate(() => {
  const app = document.querySelector('arrangement-app') as any;
  const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
  if (!cv) return null;
  const ctx = cv.getContext('2d')!;
  const px: number[] = [];
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = Math.max(0, Math.min(cv.width - 1, Math.floor((cv.width * (i + 0.5)) / 5)));
      const y = Math.max(0, Math.min(cv.height - 1, Math.floor((cv.height * (j + 0.5)) / 5)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      px.push(d[0], d[1], d[2]);
    }
  }
  return px;
});

/** Wait until the monitor shows a stable non-blank frame, then sample it. */
async function renderAndSample(url: string): Promise<number[]> {
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

  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
    { timeout: 20_000 },
  );
  await buildScenario();

  // Wait for a painted, non-black monitor (the composite committed).
  await page.waitForFunction(() => {
    const app = document.querySelector('arrangement-app') as any;
    const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!cv || cv.width === 0) return false;
    const d = cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
    return d[0] + d[1] + d[2] > 10;
  }, { timeout: 30_000 });
  // Let a few more frames settle (steady state), then sample twice and require
  // stability so we never compare a mid-transition frame.
  await new Promise((r) => setTimeout(r, 500));
  const a = await sampleGrid();
  await new Promise((r) => setTimeout(r, 200));
  const b = await sampleGrid();
  expect(a).not.toBeNull();
  expect(b).toEqual(a);
  expect(errors).toEqual([]);
  return a!;
}

describe('Arrangement comp mode A/B pixel parity (GPU)', () => {
  jest.setTimeout(120_000);

  it('renders identical pixels through the TS path and the in-wasm comp executor', async () => {
    const legacy = await renderAndSample(URL);
    const comp = await renderAndSample(`${URL}?compMode=1`);

    expect(comp.length).toBe(legacy.length);
    let maxDiff = 0;
    for (let i = 0; i < legacy.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(legacy[i] - comp[i]));
    }
    // Same executor, deep-equal sketch → identical pixels (≤1 for 2d-canvas
    // premultiplication rounding safety).
    expect(maxDiff).toBeLessThanOrEqual(1);
    // And the scene actually renders something non-trivial (inverted blue mix).
    expect(Math.max(...legacy)).toBeGreaterThan(30);
  });
});
