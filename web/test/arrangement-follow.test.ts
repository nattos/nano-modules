/**
 * GPU e2e: FOLLOW ACTIONS — core.transport.follow driving scene chains on the
 * live web engine: doc → worker registry → pre-pass → streams.seek queue →
 * drain → comp_launch_scene → scenes channel → store.sceneLaunchState.
 * Asserts group-scoped Next cycling (a grid gap excludes the third scene) and
 * that the heal defers (scenes chain instead of one-shot-stopping).
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-follow
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Scene track: red(bar 0) + green(bar 1) contiguous, blue(bar 3) across a
 *  gap. All carry Follow(Next, Group) with a 1-beat override so the chain
 *  cycles fast (0.5 s/step at 120 BPM). */
const buildScenario = () => page.evaluate(() => {
  const store = (window as any).arrangementStore;
  const st = store.addSceneTrack();
  const beatsPerBar = store.composition.meta.timeSignature[0];
  const mkScene = (name: string, bar: number, color: number[]) => {
    const path = store.createEmptyClip(st, bar * beatsPerBar);
    const [, tId, cId] = path.split('/');
    store.addClipDeviceType(tId, cId, 'source.solid_color');
    const clip = store.trackById(tId).clips.find((c: any) => c.id === cId);
    Object.assign(clip.sketch.devices[0].state ??= {}, { color });
    const devId = store.insertClipTransportDeviceAt(tId, cId, 0, 'core.transport.follow');
    store.setClipTransportDeviceField(tId, cId, devId, 'mode', 0);        // Next
    store.setClipTransportDeviceField(tId, cId, devId, 'scope', 0);       // Group
    store.setClipTransportDeviceField(tId, cId, devId, 'followAfter', 1); // Beats
    store.setClipTransportDeviceField(tId, cId, devId, 'followBeats', 1);
    return cId;
  };
  const red = mkScene('red', 0, [1, 0, 0]);
  const green = mkScene('green', 1, [0, 1, 0]);
  const blue = mkScene('blue', 3, [0, 0, 1]);
  store.docRev++; // direct state mutations above (test-only) — re-mirror
  store.positionBeat = 0;
  return { st, red, green, blue };
});

const playingScene = (st: string) => page.evaluate(
  (t) => (window as any).arrangementStore.sceneLaunchState[t]?.sceneId ?? null, st);

/** Wait until the playing scene on `st` changes away from `from`. */
async function waitForSceneChange(st: string, from: string | null, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const now = await playingScene(st);
    if (now !== from) return now;
    await new Promise((res) => setTimeout(res, 80));
  }
  throw new Error(`timeout waiting for ${label}; still=${from}`);
}

describe('Follow actions (GPU)', () => {
  jest.setTimeout(180_000);

  it('Next cycles within the contiguous group; the gap excludes blue', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    // The follow effect must be discovered before devices stamp capabilities
    // (an undiscovered module stamps nothing and the section stays inert).
    await page.waitForFunction(
      () => !!(window as any).arrangementStore.enginePlugins['core.transport.follow'],
      { timeout: 30_000 },
    );
    const ids = await buildScenario();

    await page.evaluate((a) => {
      const store = (window as any).arrangementStore;
      store.playing = true;
      store.launchScene(a.st, a.red);
    }, ids);
    expect(await playingScene(ids.st)).toBe(ids.red);

    // red's 1-beat override elapses → green (Next within the group)...
    expect(await waitForSceneChange(ids.st, ids.red, 'red→green')).toBe(ids.green);
    // ...green is the group's end → wraps to red, never blue across the gap...
    expect(await waitForSceneChange(ids.st, ids.green, 'green wraps to red')).toBe(ids.red);
    // ...and keeps cycling (relaunch re-armed the follower; heal deferred).
    expect(await waitForSceneChange(ids.st, ids.red, 'cycle continues')).toBe(ids.green);

    expect(errors).toEqual([]);
  });

  it('Auto rides the SEMANTIC event timeline: a looping video scene follows at the first looped edge, not the duration math', async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => !!(window as any).arrangementStore.enginePlugins['core.transport.follow'],
      { timeout: 30_000 },
    );
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const st = store.addSceneTrack();
      const beatsPerBar = store.composition.meta.timeSignature[0];
      // Scene A: a VIDEO scene (fake media → the engine's test-input fallback;
      // the streams table only needs the metadata). Loop slice [0,1]s with a
      // 0.5s play-start: the first 'looped' edge lands at 0.5s — the standard
      // duration says 1.0s. Auto must fire at the EDGE (event timeline), and
      // the launch-beat delta proves which clock fired (dt-invariant).
      const a = store.addVideoClip(st, 0,
        { sourceKey: 'ktest', url: 'blob:none', frameCount: 300, fps: 30, label: 'v' },
        beatsPerBar).split('/')[2];
      const b = store.createEmptyClip(st, beatsPerBar).split('/')[2];
      store.addClipDeviceType(st, b, 'source.solid_color');
      const clipA = store.trackById(st).clips.find((c: any) => c.id === a);
      clipA.loop = { mode: 'time', startSec: 0, endSec: 1, playStartSec: 0.5, speed: 1 };
      store.insertClipTransportDeviceAt(st, a, 0, 'core.transport.follow'); // all defaults: Next/Track/Auto
      store.docRev++;
      store.positionBeat = 0;
      // LIVE mode: UI launches commit instantly — this test pins the EVENT
      // TIMELINE math, so keep it decoupled from gapless-handover deferral
      // (the fake blob URL would otherwise pend until the open gives up).
      store.setTransportMode('live');
      store.playing = true;
      store.launchScene(st, a);
      return { st, a, b };
    });
    expect(await playingScene(ids.st)).toBe(ids.a);
    const next = await waitForSceneChange(ids.st, ids.a, 'A follows to B at the looped edge');
    expect(next).toBe(ids.b);
    // 0.5s at 120 BPM = 1 beat; the duration clock would be 2 beats. Allow
    // one frame of drain latency but stay decisively under the 2-beat line.
    const delta = await page.evaluate((x) => {
      const ls = (window as any).arrangementStore.sceneLaunchState[x.st];
      return ls?.launchBeat ?? null;
    }, ids);
    expect(delta).not.toBeNull();
    expect(delta!).toBeGreaterThan(0.8);
    expect(delta!).toBeLessThan(1.7);
  });

  it('primed precache: a REAL-media follow ping-pong opens NO pending window in Precise mode', async () => {
    // The user-visible artifact this pins: with warm-only precache the follow
    // launch always DEFERRED (warm pumps never inject → readiness can't latch
    // pre-request), and the 2-4 frame commit round-trip rendered the outgoing
    // loop wrapping back to its start. Primed candidates inject their entry
    // frame + latch readiness ahead of the request → the launch fast-commits
    // same-frame and scenesPending never ships an entry.
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => !!(window as any).arrangementStore.enginePlugins['core.transport.follow'],
      { timeout: 30_000 },
    );
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const st = store.addSceneTrack();
      const beatsPerBar = store.composition.meta.timeSignature[0];
      const media = {
        sourceKey: 'test_h264', url: '/media/test_h264.mp4',
        frameCount: 55, fps: 30, width: 1280, height: 720, label: 'h264',
      };
      const mk = (bar: number) => {
        const id = store.addVideoClip(st, bar * beatsPerBar, media, beatsPerBar).split('/')[2];
        const clip = store.trackById(st).clips.find((c: any) => c.id === id);
        clip.loop = { mode: 'time', startSec: 0, speed: 1 }; // full-file loop ≈1.83 s
        store.insertClipTransportDeviceAt(st, id, 0, 'core.transport.follow'); // Next/Track/Auto
        return id;
      };
      const a = mk(0);
      const b = mk(1);
      store.docRev++;
      store.positionBeat = 0;
      store.setTransportMode('precise');
      store.playing = true;
      store.launchScene(st, a);
      return { st, a, b };
    });

    // The INITIAL launch legitimately defers (cold media, Precise): wait for
    // the commit, then baseline the pending-window counter.
    await page.waitForFunction((x: any) => {
      const s = (window as any).arrangementStore.sceneLaunchState[x.st];
      return !!s && s.sceneId === x.a;
    }, { timeout: 20_000 }, ids);
    const basePending = await page.evaluate(
      () => ((globalThis as any).__arrPendingReports ?? 0) as number);

    // The candidate precache arms immediately (loop pass 1.83 s < the 2 s
    // window): B must ship PRIMED and its pump must inject the entry frame.
    await page.waitForFunction((x: any) => {
      const bridge = (window as any).__engineBridge;
      const primed = bridge?.compPumpDescs?.some((d: any) => d.clipId === x.b && d.prime);
      const pump = bridge?.video?.pumps?.get(x.b);
      return !!primed && pump?.primedFrame != null;
    }, { timeout: 15_000 }, ids);

    // Three hops of the ping-pong (A→B→A→B), every one a fast-path commit.
    let cur: string | null = ids.a;
    for (const expect_ of [ids.b, ids.a, ids.b]) {
      cur = await waitForSceneChange(ids.st, cur, `hop to ${expect_}`);
      expect(cur).toBe(expect_);
    }
    const endPending = await page.evaluate(
      () => ((globalThis as any).__arrPendingReports ?? 0) as number);
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    // Zero pending windows across all three handovers — same-frame commits.
    expect(endPending).toBe(basePending);
    expect(errors).toEqual([]);
  });
});
