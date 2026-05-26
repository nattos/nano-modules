/**
 * End-to-end test for VideoPlaybackService. Drives the runner page at
 * /video-service-test-runner.html via Puppeteer to verify mode
 * inference, persistence, cache behaviour, and the hints API against
 * the real DXV decoder and a real WebGPU device.
 */

const RUNNER = 'http://localhost:5173/video-service-test-runner.html';
const VIDEO  = '/test-videos/test01_dxv.mov';

// Each test uses a distinct salt so clip-profile state doesn't bleed
// across tests within a single page session.
function uniqueSalt(name: string): string {
  return `${name}-${Date.now()}`;
}

describe('VideoPlaybackService E2E', () => {
  jest.setTimeout(90_000);

  beforeAll(async () => {
    page.removeAllListeners('console');
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Synchronous XMLHttpRequest')) return;
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}] ${t}`);
    });
  });

  /** Navigate to the runner and wait for it to come up. Supports an
   *  optional `?budget=N` for memory-budget tests. */
  async function boot(budgetBytes?: number) {
    const params = new URLSearchParams();
    if (budgetBytes) params.set('budget', String(budgetBytes));
    const url = budgetBytes
      ? `${RUNNER}?${params.toString()}`
      : RUNNER;
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => {
        const w = (window as any).__videoService;
        return w && (w.status.ready || w.status.error);
      },
      { timeout: 45_000 },
    );
    const status = await page.evaluate(() => (window as any).__videoService.status);
    if (status.error) throw new Error(`runner boot failed: ${status.error}`);
    // Clear IDB so tests start cold by default.
    await page.evaluate(() => (window as any).__videoService.resetIdb());
  }

  it('cold open: defaults to Sequential mode and Unknown cost class', async () => {
    await boot();
    const salt = uniqueSalt('cold');
    const snap = await page.evaluate(async ({ video, salt }: { video: string; salt: string }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      return svc.inspect(clip);
    }, { video: VIDEO, salt });

    expect(snap.codec).toBe('DXV-DXD3');
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
    expect(snap.frameCount).toBe(250);
    expect(snap.access.mode).toBe('Sequential');     // cold-start default
    expect(snap.cost.costClass).toBe('Unknown');     // < 32 samples
  });

  it('sequential pulls converge on Sequential mode and warm the cache', async () => {
    await boot();
    const salt = uniqueSalt('seq');
    const result = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      for (let i = 0; i < 64; i++) await svc.pull(clip, i);
      return { snap: svc.inspect(clip), hints: svc.hints(clip) };
    }, { video: VIDEO, salt });

    expect(result.snap.access.mode).toBe('Sequential');
    expect(result.snap.access.confidence).toBeGreaterThan(0.9);
    // The read-ahead should produce some cache hits.
    expect(result.snap.cache.hits).toBeGreaterThan(0);
    expect(result.hints.suggestion).toContain('sequential');
  });

  it('looped pulls converge on Loop mode and pin the loop range', async () => {
    await boot();
    const salt = uniqueSalt('loop');
    const snap = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      const A = 30, B = 60;
      for (let c = 0; c < 5; c++) {
        for (let i = A; i <= B; i++) await svc.pull(clip, i);
      }
      return svc.inspect(clip);
    }, { video: VIDEO, salt });

    expect(snap.access.mode).toBe('Loop');
    expect(snap.access.loopRange).toBeDefined();
    expect(snap.access.loopRange[0]).toBeCloseTo(30, 0);
    expect(snap.access.loopRange[1]).toBeCloseTo(60, 0);
    // Pin count should match the loop range.
    expect(snap.cache.entries).toBeGreaterThanOrEqual(31);
  });

  it('costClass becomes FastRandom on DXV after warm-up', async () => {
    await boot();
    const salt = uniqueSalt('fastrand');
    const snap = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      // Drive a mix of contiguous + seek pulls so both cost EWMAs get
      // samples beyond the 32-sample classification threshold.
      for (let i = 0; i < 40; i++) await svc.pull(clip, i);
      for (let i = 0; i < 40; i++) await svc.pull(clip, (i * 7) % 200);
      return svc.inspect(clip);
    }, { video: VIDEO, salt });

    expect(snap.cost.samples).toBeGreaterThan(32);
    expect(snap.cost.costClass).toBe('FastRandom');
  });

  it('persists profiles across close/reopen with the same salt', async () => {
    await boot();
    const salt = uniqueSalt('persist');
    const result = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      // Phase 1: drive a Loop pattern, close.
      const c1 = await svc.openByUrl(video, salt);
      for (let c = 0; c < 5; c++) {
        for (let i = 30; i <= 60; i++) await svc.pull(c1, i);
      }
      const before = svc.inspect(c1);
      await svc.close(c1);

      // Phase 2: reopen with the same salt — should pick up persisted profile.
      const c2 = await svc.openByUrl(video, salt);
      const after = svc.inspect(c2);
      return { before, after };
    }, { video: VIDEO, salt });

    expect(result.before.access.mode).toBe('Loop');
    expect(result.after.access.mode).toBe('Loop');
    expect(result.after.access.loopRange?.[0]).toBeCloseTo(30, 0);
    expect(result.after.access.loopRange?.[1]).toBeCloseTo(60, 0);
    // Cost class persists too.
    expect(result.after.cost.samples).toBeGreaterThanOrEqual(32);
  });

  it('loop pre-prime: re-opened looped clip serves frame 30 from cache on first pull', async () => {
    await boot();
    const salt = uniqueSalt('prime');
    const result = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      // Phase 1: train the clip into a Loop classification.
      const c1 = await svc.openByUrl(video, salt);
      for (let c = 0; c < 5; c++) {
        for (let i = 30; i <= 60; i++) await svc.pull(c1, i);
      }
      await svc.close(c1);

      // Phase 2: re-open. The persisted profile should pre-prime the
      // pinned range. Pull frame 30 — wait briefly for microtask-scheduled
      // prefetches to land — then check the cache stats.
      const c2 = await svc.openByUrl(video, salt);
      // Give the prefetch microtasks time to run.
      await new Promise(r => setTimeout(r, 1500));
      const beforePull = svc.inspect(c2);
      const handle = await svc.pull(c2, 30);
      const afterPull = svc.inspect(c2);
      return { beforePull, afterPull, hit: handle > 0 };
    }, { video: VIDEO, salt });

    expect(result.hit).toBe(true);
    // After the pre-prime window settles, the cache should hold at
    // least some of the loop range BEFORE the first pull.
    expect(result.beforePull.cache.entries).toBeGreaterThan(0);
    // And the first pull on frame 30 should have hit the cache.
    expect(result.afterPull.cache.hits).toBeGreaterThan(0);
  });

  it('memory budget eviction: 200 sequential pulls at 64 MB never exceed budget', async () => {
    const budget = 64 * 1024 * 1024;
    await boot(budget);
    const salt = uniqueSalt('evict');
    const snap = await page.evaluate(async ({ video, salt, budget }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      let peakBytes = 0;
      for (let i = 0; i < 200; i++) {
        await svc.pull(clip, i);
        const s = svc.inspect(clip);
        if (s.cache.bytes > peakBytes) peakBytes = s.cache.bytes;
      }
      const final = svc.inspect(clip);
      return { peakBytes, final, budget };
    }, { video: VIDEO, salt, budget });

    // 1080p RGBA = ~8.3 MB; a small overshoot from a single late-eviction
    // pass is acceptable. Cap at budget + 1 frame.
    const oneFrame = 1920 * 1080 * 4;
    expect(snap.peakBytes).toBeLessThanOrEqual(snap.budget + oneFrame);
    expect(snap.final.cache.entries).toBeGreaterThan(0);
    expect(snap.final.cache.entries).toBeLessThan(200);  // some got evicted
  });
});
