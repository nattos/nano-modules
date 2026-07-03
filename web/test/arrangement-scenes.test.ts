/**
 * GPU e2e: SCENE TRACKS — live-launched clips on the comp executor. Covers the
 * full launch lifecycle against real pixels: launch (composite changes), switch
 * (mutual exclusion), retrigger (re-anchor mirror), stop (base layer returns),
 * delete-playing-scene (engine heal), and the scene-cell CLICK path through the
 * real <arr-scene> component.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-scenes
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Base layer (dim blue solid under the playhead) + a scene track with a RED
 *  and a GREEN scene. The base layer keeps the monitor meaningful while no
 *  scene plays (an empty composite leaves the LAST frame on canvas). */
const buildScenario = () => page.evaluate(() => {
  const store = (window as any).arrangementStore;
  const base = store.composition.tracks.find((t: any) => t.kind === 'track') ??
               store.trackById(store.addTrack());
  const basePath = store.createEmptyClip(base.id, 40, 8);
  const [, btId, bcId] = basePath.split('/');
  store.addClipDeviceType(btId, bcId, 'source.solid_color');
  {
    const clip = store.trackById(btId).clips.find((c: any) => c.id === bcId);
    Object.assign(clip.sketch.devices[0].state ??= {}, { color: [0, 0, 0.3] });
  }
  const st = store.addSceneTrack();
  // Distinct grid spots: scenes are rigid one-bar cells now, and auto channels
  // follow GRID order — red at bar 1 (channel 1), green at bar 2 (channel 2).
  const mkScene = (color: number[], beat: number) => {
    const path = store.createEmptyClip(st, beat);
    const [, tId, cId] = path.split('/');
    store.addClipDeviceType(tId, cId, 'source.solid_color');
    const clip = store.trackById(tId).clips.find((c: any) => c.id === cId);
    Object.assign(clip.sketch.devices[0].state ??= {}, { color });
    return cId;
  };
  const red = mkScene([1, 0, 0], 0);
  const green = mkScene([0, 1, 0], 4);
  store.docRev++; // direct state mutations above (test-only) — re-mirror the doc
  store.positionBeat = 42;
  return { sceneTrackId: st, red, green };
});

/** Mean RGB over a 5×5 grid of the monitor canvas. */
const meanRgb = () => page.evaluate(() => {
  const app = document.querySelector('arrangement-app') as any;
  const cv = app?.shadowRoot?.querySelector('arr-monitor')?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null;
  if (!cv || cv.width === 0) return null;
  const ctx = cv.getContext('2d')!;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = Math.max(0, Math.min(cv.width - 1, Math.floor((cv.width * (i + 0.5)) / 5)));
      const y = Math.max(0, Math.min(cv.height - 1, Math.floor((cv.height * (j + 0.5)) / 5)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      r += d[0]; g += d[1]; b += d[2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
});

/** Wait until the monitor's mean RGB satisfies `pred` (evaluated host-side). */
async function waitForColor(pred: (c: { r: number; g: number; b: number }) => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  let last: { r: number; g: number; b: number } | null = null;
  while (Date.now() < deadline) {
    last = await meanRgb();
    if (last && pred(last)) return last;
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function boot() {
  const errors: string[] = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
    { timeout: 20_000 },
  );
  const ids = await buildScenario();
  // Base layer committed: dim blue.
  await waitForColor((c) => c.b > 30 && c.r < 30 && c.g < 30, 'base blue');
  return { ids, errors };
}

describe('Arrangement scene tracks (GPU)', () => {
  jest.setTimeout(180_000);

  it('launch / switch / retrigger / stop / delete-playing lifecycle', async () => {
    const { ids, errors } = await boot();

    // Launch RED via the store API (the same call the cell click makes).
    await page.evaluate((a) => (window as any).arrangementStore.launchScene(a.sceneTrackId, a.red), ids);
    await waitForColor((c) => c.r > 120 && c.g < 60, 'red scene');

    // Switch to GREEN: mutual exclusion — red leaves, green plays.
    await page.evaluate((a) => (window as any).arrangementStore.launchScene(a.sceneTrackId, a.green), ids);
    await waitForColor((c) => c.g > 120 && c.r < 60, 'green scene');

    // Retrigger green after a scrub: the engine mirror re-anchors launchBeat.
    await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      store.positionBeat = 44;
      store.launchScene(a.sceneTrackId, a.green);
    }, ids);
    await page.waitForFunction((a: any) => {
      const s = (window as any).arrangementStore.sceneLaunchState[a.sceneTrackId];
      return !!s && s.sceneId === a.green && s.launchBeat > 43;
    }, { timeout: 15_000 }, ids);

    // Stop: back to the dim blue base.
    await page.evaluate((a) => (window as any).arrangementStore.stopScene(a.sceneTrackId), ids);
    await waitForColor((c) => c.b > 30 && c.g < 30, 'base after stop');

    // Delete the playing scene: the edit round-trips a doc reload; the engine
    // HEALS the dangling launch and mirrors the empty state back.
    await page.evaluate((a) => (window as any).arrangementStore.launchScene(a.sceneTrackId, a.red), ids);
    await waitForColor((c) => c.r > 120, 'red again');
    await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      const t = store.trackById(a.sceneTrackId);
      t.clips.splice(t.clips.findIndex((c: any) => c.id === a.red), 1);
      store.docRev++; // test-only direct mutation — re-mirror the doc
    }, ids);
    await waitForColor((c) => c.r < 30 && c.b > 30, 'base after delete');
    await page.waitForFunction(
      (a: any) => !(window as any).arrangementStore.sceneLaunchState[a.sceneTrackId],
      { timeout: 15_000 }, ids,
    );

    expect(errors).toEqual([]);
  });

  it('mod.trigger.beat launches scenes programmatically on the comp clock', async () => {
    const { ids, errors } = await boot();

    // Host a beat trigger in a long clip at the playhead: channel 1 → RED's
    // auto-assigned channel. No wires — the global trigger bus is the default
    // for both the source and the scenes.
    await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      const base = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(base.id, 0, 64);
      const [, tId, cId] = path.split('/');
      store.addClipDeviceType(tId, cId, 'mod.trigger.beat');
      const clip = store.trackById(tId).clips.find((c: any) => c.id === cId);
      // division 4 = every beat (0.5 s at 120 BPM) — fast, deterministic tests.
      Object.assign(clip.sketch.devices[0].state ??= {}, { division: 4, channel: 1 });
      store.docRev++; // direct state mutation (test-only) — re-mirror the doc
      (window as any).__trig = { tId, cId, devId: clip.sketch.devices[0].id };
      store.positionBeat = 0;
      store.playing = true;
    }, ids);

    // The trigger fires within a beat or two and RED launches — through the
    // REAL published ring + the comp-owned barPhase (not wall-clock 120).
    await page.waitForFunction((a: any) => {
      const s = (window as any).arrangementStore.sceneLaunchState[a.sceneTrackId];
      return !!s && s.sceneId === a.red;
    }, { timeout: 20_000 }, ids);
    await waitForColor((c) => c.r > 120 && c.g < 60, 'red via trigger');

    // Retarget the trigger to channel 2 → GREEN takes the slot on the next tick.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const t = (window as any).__trig;
      store.setClipDeviceField(t.tId, t.cId, t.devId, 'channel', 2);
    });
    await page.waitForFunction((a: any) => {
      const s = (window as any).arrangementStore.sceneLaunchState[a.sceneTrackId];
      return !!s && s.sceneId === a.green;
    }, { timeout: 20_000 }, ids);
    await waitForColor((c) => c.g > 120 && c.r < 60, 'green via trigger');

    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    expect(errors).toEqual([]);
  });

  it('launching a VIDEO scene does not stall the transport (readiness reaches the gate)', async () => {
    const { ids, errors } = await boot();
    await page.waitForFunction(
      () => ((window as any).__engineBridge?.discoveredEffects?.() ?? []).includes('source.video.file'),
      { timeout: 30_000 },
    );

    // A real-media video scene + Precise mode (the stall repro: the gate held
    // forever because the launched scene's clip never got a readiness edge).
    const videoScene = await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      const path = store.addVideoClip(a.sceneTrackId, 8, {
        sourceKey: 'test_h264', url: '/media/test_h264.mp4',
        frameCount: 55, fps: 30, width: 1280, height: 720, label: 'h264',
      }, 8);
      if (!path) throw new Error('addVideoClip on the scene track failed');
      store.setTransportMode('precise');
      store.setPosition(40);
      store.playing = true;
      return path.split('/')[2] as string;
    }, ids);

    // Let the transport roll, then launch the video scene mid-playback.
    await new Promise((r) => setTimeout(r, 800));
    const beatAtLaunch = await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      store.launchScene(a.st, a.scene);
      return store.positionBeat as number;
    }, { st: ids.sceneTrackId, scene: videoScene });

    // 3s at 120 BPM ≈ 6 beats. A brief decode hold is fine; a PERMANENT hold
    // (the bug: ~1 forced frame per 2.5s) is not — require real progress.
    await new Promise((r) => setTimeout(r, 3000));
    const beatAfter = await page.evaluate(() => (window as any).arrangementStore.positionBeat as number);
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    expect(beatAfter - beatAtLaunch).toBeGreaterThan(3);

    expect(errors).toEqual([]);
  });

  it('clicking a scene cell body launches it (real component path)', async () => {
    const { ids, errors } = await boot();

    // Click GREEN's cell body inside the nested shadow roots (scene cells live
    // directly on the grid lane now — grid-placed like clips).
    const clicked = await page.evaluate((a) => {
      const app = document.querySelector('arrangement-app') as any;
      const grid = app?.shadowRoot?.querySelector('arr-grid') as any;
      const cells = Array.from(grid?.shadowRoot?.querySelectorAll('arr-scene') ?? []) as any[];
      const cell = cells.find((el) => el.clip?.id === a.green);
      const body = cell?.shadowRoot?.querySelector('.body') as HTMLElement | undefined;
      if (!body) return false;
      body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0 }));
      return true;
    }, ids);
    expect(clicked).toBe(true);

    await waitForColor((c) => c.g > 120 && c.r < 60, 'green via click');
    // The cell shows the playing highlight (engine mirror → class).
    await page.waitForFunction((a: any) => {
      const app = document.querySelector('arrangement-app') as any;
      const grid = app?.shadowRoot?.querySelector('arr-grid') as any;
      const cells = Array.from(grid?.shadowRoot?.querySelectorAll('arr-scene') ?? []) as any[];
      return cells.some((el) => el.clip?.id === a.green && el.classList.contains('playing'));
    }, { timeout: 15_000 }, ids);

    expect(errors).toEqual([]);
  });

  it('header drag inside a multi-cell time box moves the GROUP; dblclick opens the clip panel', async () => {
    const { ids, errors } = await boot();

    // Arm a time box over BOTH cells (what a region select leaves), then drag
    // RED's header right by 8 beats through the REAL pointer pipeline
    // (onHeaderDown → grabWithinTimeBox keeps the box → beginClipMove timebox
    // path). The regression: select() collapsed the box and only RED moved.
    // 8 beats lands red in EMPTY space past green — a +4 drag would let the
    // rigid push coincidentally shove green where the group move puts it.
    const after = await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      const app = document.querySelector('arrangement-app') as any;
      const grid = app?.shadowRoot?.querySelector('arr-grid') as any;
      const cells = Array.from(grid?.shadowRoot?.querySelectorAll('arr-scene') ?? []) as any[];
      const redCell = cells.find((el) => el.clip?.id === a.red);
      const greenCell = cells.find((el) => el.clip?.id === a.green);
      const bar = redCell?.shadowRoot?.querySelector('.bar') as HTMLElement | undefined;
      if (!bar || !greenCell) return { err: 'cells not found' };
      // 8 beats in pixels = 2× the red→green cell offset (they sit 4 beats apart).
      const dx8 = 2 * (greenCell.getBoundingClientRect().x - redCell.getBoundingClientRect().x);
      const r = bar.getBoundingClientRect();
      const x0 = r.x + r.width / 2;
      const y0 = r.y + r.height / 2;
      store.setTimeSelection(0, 8, [a.sceneTrackId]);
      store.selectClipsInCaret();
      const opts = { bubbles: true, composed: true, button: 0, pointerId: 1 };
      bar.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }));
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + 8, clientY: y0 }));
      window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + dx8, clientY: y0 }));
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 + dx8, clientY: y0 }));
      const t = store.trackById(a.sceneTrackId);
      const beat = (id: string) => t.clips.find((c: any) => c.id === id)?.startBeat;
      return { red: beat(a.red), green: beat(a.green) };
    }, ids);
    // Both cells shifted by the same 8 beats — the group moved, not just red
    // (the bug leaves green stranded at 4).
    expect(after).toEqual({ red: 8, green: 12 });

    // Double-clicking a scene header opens the bottom clip panel (arr-clip parity).
    const opened = await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      if (store.clipViewOpen) store.toggleClipView();
      const app = document.querySelector('arrangement-app') as any;
      const grid = app?.shadowRoot?.querySelector('arr-grid') as any;
      const cells = Array.from(grid?.shadowRoot?.querySelectorAll('arr-scene') ?? []) as any[];
      const bar = cells.find((el) => el.clip?.id === a.red)?.shadowRoot?.querySelector('.bar') as HTMLElement | undefined;
      if (!bar) return null;
      bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
      return store.clipViewOpen as boolean;
    }, ids);
    expect(opened).toBe(true);

    expect(errors).toEqual([]);
  });
});
