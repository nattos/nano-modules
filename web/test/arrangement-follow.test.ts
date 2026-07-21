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
});
