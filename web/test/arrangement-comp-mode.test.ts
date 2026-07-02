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

  it('worker-owned transport advances, mirrors back, loops at the brace, and pauses', async () => {
    await renderAndSample(`${URL}?compMode=1`); // boots + parks the playhead at 42
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      store.loopEnabled = true;
      store.loopStartBeat = 40;
      store.loopEndBeat = 44;
      store.playing = true;
    });
    // The playhead must ADVANCE (the worker's comp transport mirrors back)...
    await page.waitForFunction(
      () => (window as any).arrangementStore.positionBeat > 42.2,
      { timeout: 10_000 },
    );
    // ...and stay inside the loop brace across a wrap (2 beats/s at 120 BPM →
    // several wraps within the wait).
    await new Promise((r) => setTimeout(r, 2500));
    const during = await page.evaluate(() => (window as any).arrangementStore.positionBeat as number);
    expect(during).toBeGreaterThanOrEqual(40 - 0.25);
    expect(during).toBeLessThan(44.5);

    // Pause freezes the mirrored playhead.
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    await new Promise((r) => setTimeout(r, 300));
    const p1 = await page.evaluate(() => (window as any).arrangementStore.positionBeat as number);
    await new Promise((r) => setTimeout(r, 400));
    const p2 = await page.evaluate(() => (window as any).arrangementStore.positionBeat as number);
    expect(Math.abs(p2 - p1)).toBeLessThan(1e-6);

    // A paused scrub takes effect (seek path) — the monitor keeps rendering.
    await page.evaluate(() => (window as any).arrangementStore.setPosition(41));
    await new Promise((r) => setTimeout(r, 300));
    const p3 = await page.evaluate(() => (window as any).arrangementStore.positionBeat as number);
    expect(p3).toBeCloseTo(41, 5);
  });

  it('rails: a return-track read wire modulates its target (writer beats base re-assert)', async () => {
    // Regression: the arrangement re-asserts each rail's BASE via per-frame
    // automation (combine replace). The executor applied automation AFTER the
    // wire fold on the same field, clobbering the writer every frame — rails
    // sat pinned at base and read wires never moved their targets. A live
    // wire now wins; the re-assert only applies when the writer is gone.
    await page.goto(`${URL}?compMode=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => ((window as any).__engineBridge?.discoveredEffects?.() ?? []).includes('mod.source.lfo'),
      { timeout: 30_000 },
    );

    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const trackId = store.addTrack();
      const path = store.createEmptyClip(trackId, 0, 16);
      const [, tId, cId] = path.split('/');
      store.addClipDeviceType(tId, cId, 'source.solid_color');
      store.addClipDeviceType(tId, cId, 'mod.source.lfo');
      store.addClipDeviceType(tId, cId, 'color.tone.brightness_contrast');
      const railTrackId = store.addReturn();
      const railId = store.trackById(railTrackId).railId;
      // Re-resolve AFTER the last mutate (history rebuilds objects).
      const clip = store.trackById(tId).clips.find((c: any) => c.id === cId);
      const [solid, lfo, bc] = clip.sketch.devices;
      Object.assign(solid.state ??= {}, { color: [1, 1, 1] });
      Object.assign(lfo.state ??= {}, { rate: 2, amplitude: 1 });
      clip.exports.push({ id: 'e1', railId, sourceDeviceId: lfo.id, sourceField: 'output', combine: 'add', magnitude: 'auto' });
      clip.reads ??= [];
      clip.reads.push({ id: 'r1', railId, targetDeviceId: bc.id, targetField: 'brightness', combine: 'replace', magnitude: 'auto' });
      store.docRev++;
      store.setTransportMode('precise');
      store.setPosition(1);
      store.playing = true;
    });

    // Sample monitor luma while the LFO sweeps: the read wire must MOVE the
    // brightness (a pinned rail renders a constant frame).
    const lumas: number[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const l = await page.evaluate(() => {
        const app = document.querySelector('arrangement-app') as any;
        const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null;
        if (!cv || !cv.width) return null;
        const d = cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
        return Math.round(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
      });
      if (l !== null) lumas.push(l);
    }
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    const spread = Math.max(...lumas) - Math.min(...lumas);
    expect(lumas.length).toBeGreaterThan(5);
    expect(spread).toBeGreaterThan(60); // modulation visibly sweeps the brightness
  });

  it('media relink refreshes the document mirror (dead pre-reload URL → video recovers)', async () => {
    // Regression: loading an arrangement leaves DEAD blob URLs in the doc until
    // relinkMedia() re-mints them — an update that deliberately bypasses
    // mutate() (not undoable). The comp-mode pump is fed from the WORKER's
    // document mirror, so the relink must still bump docRev (mirror refresh)
    // or the pump opens the dead URL forever: the gate gives up (transport
    // runs) but the video never shows. Simulates exactly that flow.
    await page.goto(`${URL}?compMode=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => ((window as any).__engineBridge?.discoveredEffects?.() ?? []).includes('source.video.file'),
      { timeout: 30_000 },
    );

    const clipId = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const trackId = store.addTrack();
      // A dead URL — as a persisted blob: URL is after a reload.
      const path = store.addVideoClip(trackId, 0, {
        sourceKey: 'relink-test', url: 'blob:http://localhost/00000000-dead-dead-dead-000000000000',
        frameCount: 55, fps: 30, width: 1280, height: 720, label: 'dead',
      }, 8);
      if (!path) throw new Error('addVideoClip failed');
      store.setTransportMode('precise');
      store.setPosition(1);
      return path.split('/')[2];
    });

    // Let the pump exhaust its open retries on the dead URL (give-up ≈ 4 tries).
    await new Promise((r) => setTimeout(r, 3000));
    const before = await page.evaluate(() => (window as any).__engineBridge.videoFramesInjected() as number);
    expect(before).toBe(0);

    // Simulate relinkMedia(): swap the url IN PLACE (no mutate) + docRev++.
    await page.evaluate((id) => {
      const store = (window as any).arrangementStore;
      for (const t of store.composition.tracks) {
        for (const c of t.clips) if (c.id === id) c.source.url = '/media/test_h264.mp4';
      }
      store.docRev++;
    }, clipId);

    // The mirror refresh + url-aware failure reset must reopen and inject.
    await page.waitForFunction(
      () => (window as any).__engineBridge.videoFramesInjected() > 0,
      { timeout: 15_000 },
    );
    const hasPump = await page.evaluate((id) =>
      !!(window as any).__engineBridge.video?.pumps?.has?.(id), clipId);
    expect(hasPump).toBe(true);
  });

  it('video clip plays through without stalling (native Precise gate readiness loop)', async () => {
    // Regression: readiness edges for the native gate must flow on an
    // UNCONDITIONAL cadence. They used to ride the monitor's reactive
    // showComposite — which never fires while a hold freezes the beat — so
    // video playback deadlocked (only the 2.5s force-bypass leaked frames).
    await page.goto(`${URL}?compMode=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    await page.waitForFunction(() => (window as any).__engineBridge?.isBooted
      || !!(window as any).__engineBridge, { timeout: 20_000 });
    await page.waitForFunction(
      () => ((window as any).__engineBridge?.discoveredEffects?.() ?? []).includes('source.video.file'),
      { timeout: 30_000 },
    );

    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const trackId = store.addTrack();
      const path = store.addVideoClip(trackId, 0, {
        sourceKey: 'test_h264', url: '/media/test_h264.mp4',
        frameCount: 55, fps: 30, width: 1280, height: 720, label: 'h264',
      }, 8);
      if (!path) throw new Error('addVideoClip failed');
      store.setTransportMode('precise');
      store.setPosition(1);
    });
    await new Promise((r) => setTimeout(r, 2000)); // pump open + precache
    await page.evaluate(() => { (window as any).arrangementStore.playing = true; });

    // 3s of playback at 120 BPM ≈ 6 beats. The old deadlock advanced ~1 frame
    // per 2.5s; require real progress with generous slack for CI decode jitter.
    await new Promise((r) => setTimeout(r, 3000));
    const beat = await page.evaluate(() => (window as any).arrangementStore.positionBeat as number);
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    expect(beat).toBeGreaterThan(4);
  });
});
