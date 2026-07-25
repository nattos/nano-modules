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
