/**
 * GPU e2e: CROSSFADE TRANSITION — transition.xfade on a scene TRACK's
 * transport section, real media, Precise mode. The follow announces its
 * target, the crossfade triggers the incoming EARLY, the outgoing detaches
 * into the fork (same pump, same instances), both pumps run through the fade,
 * and the fork releases when the fade completes. The whole transition is
 * autonomous — the test only launches the first scene.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-crossfade
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const playingScene = (st: string) => page.evaluate(
  (t) => (window as any).arrangementStore.sceneLaunchState[t]?.sceneId ?? null, st);

async function waitForSceneChange(st: string, from: string | null, label: string) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const now = await playingScene(st);
    if (now !== from) return now;
    await new Promise((res) => setTimeout(res, 60));
  }
  throw new Error(`timeout waiting for ${label}; still=${from}`);
}

describe('Crossfade transition (GPU)', () => {
  jest.setTimeout(180_000);

  it('an announced follow launch crossfades: both pumps overlap, then the fork releases', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
    // Both modules must be discovered before devices stamp capabilities.
    await page.waitForFunction(
      () => !!(window as any).arrangementStore.enginePlugins['core.transport.follow'] &&
            !!(window as any).arrangementStore.enginePlugins['transition.xfade'],
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
      // The crossfade lives on the TRACK's transport section.
      const devId = store.insertTrackTransportDeviceAt(st, 0, 'transition.xfade');
      store.setTrackTransportDeviceField(st, devId, 'fadeSec', 0.6);
      store.docRev++;
      store.positionBeat = 0;
      store.setTransportMode('precise');
      store.playing = true;
      store.launchScene(st, a);
      return { st, a, b };
    });

    // A commits (the initial cold launch may legitimately pend), and its pump
    // is truly live — engine truth, not the store's optimistic click state.
    await page.waitForFunction((x: any) => {
      const s = (window as any).arrangementStore.sceneLaunchState[x.st];
      const bridge = (window as any).__engineBridge;
      const pend = (globalThis as any).__arrScenesPending ?? {};
      return !!s && s.sceneId === x.a && !pend[x.st] &&
             bridge?.video?.pumps?.get(x.a)?.lastKey != null;
    }, { timeout: 20_000 }, ids);
    const basePending = await page.evaluate(
      () => ((globalThis as any).__arrPendingReports ?? 0) as number);

    // Install the overlap watcher BEFORE the (autonomous) transition: samples
    // which pumps hold a live frame while B is the live scene.
    await page.evaluate((x: any) => {
      const seen = { overlap: 0, pendingDuring: 0 } as any;
      (globalThis as any).__xfadeSeen = seen;
      (globalThis as any).__xfadeTimer = setInterval(() => {
        const store = (window as any).arrangementStore;
        const bridge = (window as any).__engineBridge;
        const s = store.sceneLaunchState[x.st];
        if (!s || s.sceneId !== x.b) return;
        const pumps = bridge?.video?.pumps;
        const aLive = pumps?.get(x.a)?.lastKey != null;
        const bLive = pumps?.get(x.b)?.lastKey != null;
        if (aLive && bLive) seen.overlap++;
        const pend = (globalThis as any).__arrScenesPending ?? {};
        if (pend[x.st]) seen.pendingDuring++;
      }, 40);
    }, ids);

    // The transition is fully autonomous: the follow announces, the crossfade
    // triggers B early, the engine detaches A into the fork.
    expect(await waitForSceneChange(ids.st, ids.a, 'crossfade to B')).toBe(ids.b);

    // Fade window ≈0.6 s: A's pump stays live ALONGSIDE B's, then the fork
    // releases — A's desc reverts from the ACTIVE fork shape (unbounded, no
    // prime) to the WARM candidate shape (prime: it is B's Next target now).
    // If the poll misses that window, the NEXT autonomous transition (B→A at
    // B's loop end) is equal proof the fork released (a live fork's track
    // would have snap-finished it, and A could not have relaunched).
    await page.waitForFunction((x: any) => {
      const bridge = (window as any).__engineBridge;
      const d = bridge?.compPumpDescs?.find((e: any) => e.clipId === x.a);
      const released = !d || d.prime === true || (d.lengthBeat ?? 0) < 1e8;
      const hoppedBack =
        (window as any).arrangementStore.sceneLaunchState[x.st]?.sceneId === x.a;
      return released || hoppedBack;
    }, { timeout: 10_000 }, ids);

    const seen = await page.evaluate(() => {
      clearInterval((globalThis as any).__xfadeTimer);
      return (globalThis as any).__xfadeSeen;
    });
    const endPending = await page.evaluate(
      () => ((globalThis as any).__arrPendingReports ?? 0) as number);
    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });

    // The crossfade signature: a real overlap window (both decoders live
    // under B) — a hard cut would never sample one.
    expect(seen.overlap).toBeGreaterThanOrEqual(3);
    // Announced + primed → the early trigger fast-commits: no pending window
    // opened during the transition (the watcher double-checks mid-fade).
    expect(seen.pendingDuring).toBe(0);
    expect(endPending).toBe(basePending);
    expect(errors).toEqual([]);
  });
});
