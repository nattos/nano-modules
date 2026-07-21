/**
 * GPU e2e: TRANSPORT-CONTROLLER EFFECTS — the full web pipeline: transport
 * section in the doc → comp executor pre-pass (comp_transport_resolve) →
 * published transport_* state mirrored back to the store. Asserts the
 * controller's published time tracks the transport at its configured rate,
 * freezes when paused, and never touches pixels (identity).
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-transport
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** One track, one long red solid clip driven by core.transport.time at 2x. */
const buildScenario = () => page.evaluate(() => {
  const store = (window as any).arrangementStore;
  const track = store.composition.tracks.find((t: any) => t.kind === 'track') ??
                store.trackById(store.addTrack());
  const path = store.createEmptyClip(track.id, 0, 64);
  const [, tId, cId] = path.split('/');
  store.addClipDeviceType(tId, cId, 'source.solid_color');
  {
    const clip = store.trackById(tId).clips.find((c: any) => c.id === cId);
    Object.assign(clip.sketch.devices[0].state ??= {}, { color: [0.8, 0, 0] });
  }
  const devId = store.insertClipTransportDeviceAt(tId, cId, 0, 'core.transport.time');
  store.setClipTransportDeviceField(tId, cId, devId, 'speed', 2.0);
  store.positionBeat = 0;
  return { tId, cId, devId, key: `clip_${cId}_transport_${devId}` };
});

const publishedTime = (key: string) => page.evaluate(
  (k) => {
    const st = (window as any).arrangementStore.pluginStates[k];
    return st && typeof st.transport_time_sec === 'number' ? st.transport_time_sec : null;
  }, key);

const meanRgb = () => page.evaluate(() => {
  const app = document.querySelector('arrangement-app') as any;
  const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null;
  if (!cv || cv.width === 0) return null;
  const ctx = cv.getContext('2d')!;
  const d = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
  return { r: d[0], g: d[1], b: d[2] };
});

describe('Transport-controller effects (GPU)', () => {
  jest.setTimeout(180_000);

  it('core.transport.time drives published time at its rate; identity on pixels', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    // The transport palette needs the core bundle's schema discovery.
    await page.waitForFunction(
      () => !!(window as any).arrangementStore.enginePlugins['core.transport.time'],
      { timeout: 30_000 },
    );
    const ids = await buildScenario();

    await page.evaluate(() => { (window as any).arrangementStore.playing = true; });
    // The section instance publishes through the pre-pass → pluginStates mirror.
    await page.waitForFunction(
      (k: string) => {
        const st = (window as any).arrangementStore.pluginStates[k];
        return !!st && typeof st.transport_time_sec === 'number' && st.transport_time_sec > 0;
      }, { timeout: 30_000 }, ids.key,
    );

    // Rate check: published content time advances at 2x transport seconds
    // (120 BPM ⇒ 0.5 s/beat). Sampled over ~1.2 s of wall time; dt-invariant
    // via the beat delta (rAF pacing varies in headless).
    const s1 = await page.evaluate((k: string) => ({
      t: (window as any).arrangementStore.pluginStates[k].transport_time_sec as number,
      beat: (window as any).arrangementStore.positionBeat as number,
    }), ids.key);
    await new Promise((res) => setTimeout(res, 1200));
    const s2 = await page.evaluate((k: string) => ({
      t: (window as any).arrangementStore.pluginStates[k].transport_time_sec as number,
      beat: (window as any).arrangementStore.positionBeat as number,
    }), ids.key);
    const transportSecDelta = (s2.beat - s1.beat) * 0.5;
    expect(transportSecDelta).toBeGreaterThan(0.3);
    expect(s2.t - s1.t).toBeGreaterThan(transportSecDelta * 1.6);
    expect(s2.t - s1.t).toBeLessThan(transportSecDelta * 2.4);

    // Identity: the composite is still the clip's solid red.
    const px = await meanRgb();
    expect(px).not.toBeNull();
    expect(px!.r).toBeGreaterThan(120);
    expect(px!.g).toBeLessThan(40);

    // Paused: the published time freezes with the transport.
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    await new Promise((res) => setTimeout(res, 300));
    const p1 = await publishedTime(ids.key);
    await new Promise((res) => setTimeout(res, 500));
    const p2 = await publishedTime(ids.key);
    expect(Math.abs((p2 ?? 0) - (p1 ?? 0))).toBeLessThan(0.05);

    expect(errors).toEqual([]);
  });
});
