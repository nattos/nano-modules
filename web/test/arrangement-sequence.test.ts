/**
 * GPU e2e: a SEQUENCE clip (⌘J "Consolidate") renders its interior in the real
 * app, end to end — the guard against the silent-black / silent-transparent
 * class that unit tests structurally cannot see.
 *
 * Three things only a live engine can prove:
 *   1. The interior is BUILT, not just contained — the live sub-clip's device
 *      instance appears in the composite chain (`Builder::push` silently drops
 *      duplicate instance keys, so a bad clone renders black with no error).
 *   2. The interior reaches the SCREEN — the monitor canvas carries structured
 *      pixels. Transparency reads as the flat backdrop fill here (the stage
 *      checkerboard is CSS on the host, never in the canvas), so a spread
 *      threshold is a real transparency assertion.
 *   3. BOTH sub-clips do (1) and (2) as the interior clock crosses — the
 *      "second interior clip is sometimes transparent" regression was N
 *      interior clips all reading as live at once and racing the decoder.
 *
 * Then Uncollapse (⇧⌘J) puts the clips back and the engine keeps rendering.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-sequence
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const GENERATOR = 'source.noise';

/** Sample a coarse grid of the monitor canvas; spread = non-uniformity of luma. */
const sampleScene = () =>
  page.evaluate(() => {
    const app = document.querySelector('arrangement-app') as any;
    const canvas = app?.shadowRoot
      ?.querySelector('arr-monitor')
      ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d')!;
    const lumas: number[] = [];
    const N = 6;
    for (let iy = 1; iy < N; iy++) {
      for (let ix = 1; ix < N; ix++) {
        const x = Math.floor((canvas.width * ix) / N);
        const y = Math.floor((canvas.height * iy) / N);
        const d = ctx.getImageData(x, y, 1, 1).data;
        lumas.push(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
      }
    }
    return { spread: Math.max(...lumas) - Math.min(...lumas) };
  });

/**
 * Poll until the monitor carries structured pixels. Real footage passes through
 * near-uniform frames and a freshly injected frame takes a beat to composite,
 * so a single sample proves nothing either way; a flat canvas for the whole
 * window is what transparency actually looks like.
 */
const waitForStructuredPixels = (timeout = 20_000) =>
  page.waitForFunction(() => {
    const app = document.querySelector('arrangement-app') as any;
    const c = app?.shadowRoot?.querySelector('arr-monitor')
      ?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    const ctx = c?.getContext('2d');
    if (!ctx) return false;
    const lum: number[] = [];
    for (let i = 1; i < 6; i++) {
      for (let j = 1; j < 6; j++) {
        const d = ctx.getImageData(
          Math.floor((c.width * j) / 6), Math.floor((c.height * i) / 6), 1, 1).data;
        lum.push(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
      }
    }
    return Math.max(...lum) - Math.min(...lum) > 8;
  }, { timeout }).then(() => true).catch(() => false);

/** The engine's current composite chain instance keys (`clip_<clipId>_<devId>`). */
const chainKeys = () =>
  page.evaluate(() => ((window as any).__engineBridge?.compositeKeys ?? []) as string[]);

const hasClip = (keys: string[], clipId: string) => keys.some((k) => k.includes(clipId));

describe('Arrangement sequence clips render (GPU)', () => {
  jest.setTimeout(90_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('composites BOTH interior sub-clips as the interior clock crosses, then uncollapses', async () => {
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

    // Two generator clips on a clear stretch of one track, consolidated into a
    // sequence spanning [40, 48). Beat 40 is past the boot doc's fake clips.
    const ids = await page.evaluate((gen) => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const mk = (start: number, len: number) => {
        const path = store.createEmptyClip(track.id, start, len);
        const [, tId, cId] = path.split('/');
        store.addClipDeviceType(tId, cId, gen);
        return cId;
      };
      const a = mk(40, 4);
      const b = mk(44, 4);
      store.setTimeSelection(40, 48, [track.id]);
      store.consolidateSelection();
      const seqs = store.trackById(track.id).clips.filter((c: any) => c.kind === 'sequence');
      store.setPosition(41); // inside interior sub-clip A
      return {
        trackId: track.id, a, b,
        seqCount: seqs.length,
        seqId: seqs[0]?.id ?? null,
        laneId: seqs[0]?.sequence?.id ?? null,
        interior: (seqs[0]?.sequence?.clips ?? []).map((c: any) => c.id),
        trackClips: store.trackById(track.id).clips.length,
      };
    }, GENERATOR);

    // Model: one sequence clip; both originals moved INSIDE it, in order.
    expect(ids.seqCount).toBe(1);
    expect(ids.interior).toEqual([ids.a, ids.b]);
    expect(ids.laneId).toBeTruthy();
    expect(ids.laneId).not.toBe(ids.trackId); // the lane is its own addressable track

    // The engine boots and reports content at the sequence clip's span.
    await page.waitForFunction(
      () => {
        const b = (window as any).__engineBridge;
        return b?.isBooted && b.framesSeen > 4 && b.hasContent;
      },
      { timeout: 45_000 },
    );

    // (1) The LIVE interior sub-clip is in the built chain.
    await page.waitForFunction(
      (a: string) => ((window as any).__engineBridge?.compositeKeys ?? []).some(
        (k: string) => k.includes(a)),
      { timeout: 20_000 }, ids.a,
    );
    const keysA = await chainKeys();
    expect(hasClip(keysA, ids.a)).toBe(true);
    expect(hasClip(keysA, ids.b)).toBe(false); // only ONE interior clip is live

    // (2) ...and it reaches the screen as structured pixels, not transparency.
    const first = await sampleScene();
    expect(first).not.toBeNull();
    expect(first!.spread).toBeGreaterThan(8);

    // (3) Cross into the SECOND sub-clip: the chain swaps and it renders too.
    await page.evaluate(() => (window as any).arrangementStore.setPosition(45));
    await page.waitForFunction(
      (b: string) => ((window as any).__engineBridge?.compositeKeys ?? []).some(
        (k: string) => k.includes(b)),
      { timeout: 20_000 }, ids.b,
    );
    const keysB = await chainKeys();
    expect(hasClip(keysB, ids.b)).toBe(true);
    expect(hasClip(keysB, ids.a)).toBe(false);

    const second = await sampleScene();
    expect(second).not.toBeNull();
    expect(second!.spread).toBeGreaterThan(8); // the "second clip is transparent" bug

    // Uncollapse (⇧⌘J) lifts the sub-clips back onto the track at absolute beats.
    const after = await page.evaluate((d) => {
      const store = (window as any).arrangementStore;
      store.setSelection([`clip/${d.trackId}/${d.seqId}`]);
      store.uncollapseSelection();
      const clips = store.trackById(d.trackId).clips;
      return {
        seqCount: clips.filter((c: any) => c.kind === 'sequence').length,
        spans: clips.filter((c: any) => c.id === d.a || c.id === d.b)
          .sort((x: any, y: any) => x.startBeat - y.startBeat)
          .map((c: any) => [c.startBeat, c.lengthBeat]),
      };
    }, ids);
    expect(after.seqCount).toBe(0);
    expect(after.spans).toEqual([[40, 4], [44, 4]]);

    // Still rendering after the round trip (the lifted clip is live at beat 45).
    await page.waitForFunction(
      (b: string) => ((window as any).__engineBridge?.compositeKeys ?? []).some(
        (k: string) => k.includes(b)),
      { timeout: 20_000 }, ids.b,
    );
    const restored = await sampleScene();
    expect(restored!.spread).toBeGreaterThan(8);

    expect(errors).toEqual([]);
  });
});

/**
 * The one leg the engine-level tests could not reach: a REAL autopilot hop
 * through a scene-mode interior, driven by an actual decoder.
 *
 * "It's a track to the compositor" holds for rendering but NOT for prefetch and
 * launch — those key off scene scans and the lookahead scan, neither of which
 * originally saw inside a clip. The native tests pin that plumbing with
 * synthetic clips; only real media exercises the part that bit us twice: the
 * decode pump, the primed handover, and the Precise gate holding on a cold
 * interior clip. Media is /media/test_h264.mp4 (committed, 55f @30 ≈1.83 s).
 */
describe('Sequence interior: follow autopilot on real media (GPU)', () => {
  jest.setTimeout(180_000);

  const playingScene = (laneId: string) => page.evaluate(
    (l) => (window as any).arrangementStore.sceneLaunchState[l]?.sceneId ?? null, laneId);

  /** Wait until the interior lane's live scene changes away from `from`. */
  async function waitForHop(laneId: string, from: string | null, label: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const now = await playingScene(laneId);
      if (now !== from) return now;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`timeout waiting for ${label}; still=${from}`);
  }

  it('hops A→B→A inside the interior, priming the incoming sub-clip each time', async () => {
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

    // The real user path: two video clips → ⌘J → flip the interior to scene
    // mode → drop a follower on each interior cell.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const bar = store.composition.meta.timeSignature[0];
      const media = {
        sourceKey: 'test_h264', url: '/media/test_h264.mp4',
        frameCount: 55, fps: 30, width: 1280, height: 720, label: 'h264',
      };
      const mk = (n: number) =>
        store.addVideoClip(track.id, n * bar, media, bar).split('/')[2];
      const a = mk(0);
      const b = mk(1);

      store.setTimeSelection(0, 2 * bar, [track.id]);
      store.consolidateSelection();
      const seq = store.trackById(track.id).clips.find((c: any) => c.kind === 'sequence');
      const laneId = seq.sequence.id;
      store.setSequenceLaneKind(track.id, seq.id, 'scene');
      // The playhead RUNS during this test, and a scene-mode interior only
      // renders while its OUTER clip is live — at 120 BPM the 2-bar span
      // consolidate produced would expire (hasContent false, empty chain)
      // mid-run while the interior kept hopping perfectly well underneath.
      store.resizeClip(track.id, seq.id, 0, 400);

      // Loop the whole file (≈1.83 s) and let Follow default to Next/Track/Auto,
      // which fires at the loop end — the same cadence the top-level suite uses.
      for (const sub of store.laneById(laneId).clips) {
        sub.loop = { mode: 'time', startSec: 0, speed: 1 };
        store.insertClipTransportDeviceAt(laneId, sub.id, 0, 'core.transport.follow');
      }
      store.docRev++; // direct loop mutation above (test-only) — re-mirror
      store.positionBeat = 1;             // inside the sequence clip's span
      store.setTransportMode('precise');
      store.playing = true;
      store.launchScene(laneId, a);
      return { trackId: track.id, seqId: seq.id, laneId, a, b };
    });

    expect(ids.laneId).toBeTruthy();
    expect(ids.a).not.toBe(ids.b);

    // The initial launch legitimately defers on cold media in Precise mode.
    await page.waitForFunction((x: any) => {
      const s = (window as any).arrangementStore.sceneLaunchState[x.laneId];
      return !!s && s.sceneId === x.a;
    }, { timeout: 30_000 }, ids);

    // Prefetch parity with real media: the follower's target ships PRIMED and
    // its pump holds the entry frame BEFORE the hop — the interior is reached
    // by the same precache machinery an ungrouped scene track gets.
    await page.waitForFunction((x: any) => {
      const bridge = (window as any).__engineBridge;
      const primed = bridge?.compPumpDescs?.some((d: any) => d.clipId === x.b && d.prime);
      return !!primed && bridge?.video?.pumps?.get(x.b)?.primedFrame != null;
    }, { timeout: 30_000 }, ids);

    // Two hops of the ping-pong, entirely inside the sequence clip.
    let cur: string | null = ids.a;
    for (const want of [ids.b, ids.a]) {
      cur = await waitForHop(ids.laneId, cur, `interior hop to ${want}`);
      expect(cur).toBe(want);
    }

    // The interior is genuinely decoding, not just flipping launch state.
    // Polled, not single-sampled: real footage passes through near-uniform
    // frames, so one unlucky sample proves nothing either way.
    expect(await waitForStructuredPixels()).toBe(true);

    await page.evaluate(() => { (window as any).arrangementStore.playing = false; });
    expect(errors).toEqual([]);
  });
});

/**
 * The interior decode contract against a REAL decoder, in the exact shape that
 * failed: two video sub-clips in one interior, crossing the interior clock.
 *
 * Every interior desc ships the sequence clip's window (unbounded, because the
 * interior loops), so the pump cannot tell live from warm by window alone — it
 * keys off `prime`. Before that fix all N interior clips read as actively
 * playing and ran full-rate decoders against the same service, and whichever
 * lost the race blanked. The native test pins the contract with synthetic
 * clips; this one puts an actual decoder under it.
 *
 * DXV deliberately (/media/test_dxv.mov, 1280×720, 57f): it is random-access
 * and decodes headlessly, and it takes the DXV decode-SERVICE path through the
 * pump rather than h264's cursor path — the one the contention showed up on.
 * The playhead stays PAUSED so the interior clock is exact, not a race.
 */
describe('Sequence interior: two real DXV sub-clips share one decoder (GPU)', () => {
  jest.setTimeout(120_000);

  /** This frame's pump desc for `clipId`, or null. */
  const descFor = (clipId: string) => page.evaluate(
    (id) => ((window as any).__engineBridge?.compPumpDescs ?? [])
      .find((d: any) => d.clipId === id) ?? null, clipId);

  it('plays only the LIVE sub-clip and primes its sibling, both sides of the switch', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );

    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const bar = store.composition.meta.timeSignature[0];
      const media = {
        sourceKey: 'arr-media:test_dxv', url: '/media/test_dxv.mov',
        frameCount: 57, fps: 30, width: 1280, height: 720, label: 'dxv',
      };
      const mk = (n: number) =>
        store.addVideoClip(track.id, n * bar, media, bar).split('/')[2];
      const a = mk(0);
      const b = mk(1);
      store.setTimeSelection(0, 2 * bar, [track.id]);
      store.consolidateSelection();
      const seq = store.trackById(track.id).clips.find((c: any) => c.kind === 'sequence');
      store.setPosition(1);   // interior beat 1 ⇒ sub-clip A is live
      return { trackId: track.id, seqId: seq.id, laneId: seq.sequence.id, a, b };
    });

    await page.waitForFunction(() => {
      const b = (window as any).__engineBridge;
      return b?.isBooted && b.framesSeen > 4 && b.hasContent;
    }, { timeout: 45_000 });

    // A is live: in the chain, and its desc is NOT primed.
    await page.waitForFunction(
      (a: string) => ((window as any).__engineBridge?.compositeKeys ?? []).some(
        (k: string) => k.includes(a)), { timeout: 20_000 }, ids.a);
    const liveA = await descFor(ids.a);
    expect(liveA).not.toBeNull();
    expect(!!liveA.prime).toBe(false);

    // B is the warm sibling: present in the desc set, but PRIMED — one decoder
    // at full rate, not two. (A missing desc would mean no pre-warm at all.)
    const warmB = await descFor(ids.b);
    expect(warmB).not.toBeNull();
    expect(!!warmB.prime).toBe(true);

    // Real frames are reaching the compositor, and the screen is not blank.
    await page.waitForFunction(
      () => (window as any).__engineBridge.videoFramesInjected() > 0, { timeout: 30_000 });
    expect(await waitForStructuredPixels()).toBe(true);

    // Cross the interior switch: the roles swap exactly, and the SECOND clip
    // renders — the regression the user hit ("first always, second sometimes").
    await page.evaluate(() => (window as any).arrangementStore.setPosition(5));
    await page.waitForFunction(
      (b: string) => ((window as any).__engineBridge?.compositeKeys ?? []).some(
        (k: string) => k.includes(b)), { timeout: 20_000 }, ids.b);

    const liveB = await descFor(ids.b);
    expect(liveB).not.toBeNull();
    expect(!!liveB.prime).toBe(false);   // B is the one playing now
    // A is BEHIND the interior clock, and a consolidated sequence spans exactly
    // its interior extent — so it does NOT loop and A is never upcoming again.
    // Dropping out of the pump entirely is correct: its decoder is released
    // rather than left spinning. (A LOOPING interior is the opposite case, and
    // the native suite pins the wrap separately.)
    expect(await descFor(ids.a)).toBeNull();

    expect(await waitForStructuredPixels()).toBe(true);

    expect(errors).toEqual([]);
  });
});
