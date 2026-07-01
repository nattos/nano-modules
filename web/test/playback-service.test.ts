/**
 * End-to-end test for VideoPlaybackService. Drives the runner page at
 * /video-service-test-runner.html via Puppeteer to verify mode
 * inference, persistence, cache behaviour, and the hints API against
 * the real DXV decoder and a real WebGPU device.
 */

const RUNNER = (process.env.GPU_TEST_BASE_URL || 'http://localhost:5173') + '/video-service-test-runner.html';
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

describe('VideoPlaybackService — browser-decoder (h264) path', () => {
  jest.setTimeout(90_000);
  const H264 = '/test-videos/test01_h264.mp4';

  async function boot() {
    await page.goto(RUNNER, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => {
        const w = (window as any).__videoService;
        return w && (w.status.ready || w.status.error);
      },
      { timeout: 45_000 },
    );
    const status = await page.evaluate(() => (window as any).__videoService.status);
    if (status.error) throw new Error(`runner boot failed: ${status.error}`);
    await page.evaluate(() => (window as any).__videoService.resetIdb());
  }

  it('opens an h264 mp4 through the <video> element and reports a video codec', async () => {
    await boot();
    const snap = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      return svc.inspect(clip);
    }, { video: H264, salt: uniqueSalt('h264-open') });

    // Routed to the browser-decoder path, NOT the DXV WASM path.
    expect(snap.codec.startsWith('video:')).toBe(true);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
    expect(snap.frameCount).toBeGreaterThan(0);
  });

  it('decodes h264 frames into RGBA8 textures with distinct content', async () => {
    await boot();
    const result = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const gpuHost = svc.gpuHost;
      const clip = await svc.openByUrl(video, salt);
      const info = svc.inspect(clip);
      const W = info.width, H = info.height;

      const sampleRow = async (frameIdx: number) => {
        // <video> sources sample the LIVE playing frame (decode ignores
        // idx), so let real time pass between samples for the playback to
        // advance to distinct content.
        const handle = await svc.pull(clip, frameIdx);
        const px = await gpuHost.readbackTexture(handle, W, H);
        const stride = W * 4;
        const row = Math.floor(H / 2);
        return Array.from(px.slice(row * stride, (row + 1) * stride));
      };

      const f0 = await sampleRow(0);
      await new Promise(r => setTimeout(r, 700));   // let playback advance
      const fMid = await sampleRow(Math.floor(info.frameCount / 2));

      // Non-trivial content on frame 0.
      let nonZero = 0, minV = 255, maxV = 0;
      for (let i = 0; i < f0.length; i += 4) {
        const lum = Math.max(f0[i], f0[i + 1], f0[i + 2]);
        if (f0[i] + f0[i + 1] + f0[i + 2] > 0) nonZero++;
        if (lum < minV) minV = lum;
        if (lum > maxV) maxV = lum;
      }
      let diff = 0;
      for (let i = 0; i < Math.min(f0.length, fMid.length); i++) diff += Math.abs(f0[i] - fMid[i]);

      return { width: W, height: H, nonZeroFrac: nonZero / (f0.length / 4), range: maxV - minV, diff };
    }, { video: H264, salt: uniqueSalt('h264-decode') });

    expect(result.nonZeroFrac).toBeGreaterThan(0.1);   // actually decoded something
    expect(result.range).toBeGreaterThan(20);          // real content, not flat
    expect(result.diff).toBeGreaterThan(1000);         // frame 0 ≠ middle frame
  });

  it('classifies a well-behaved clip as seekable and scrubs to distinct frames', async () => {
    // test01_h264 is a re-encode with frequent keyframes — it seeks
    // cleanly, so the source profile should mark it seekable (not
    // streaming) and random-access scrubbing should yield distinct,
    // non-black frames.
    await boot();
    const r = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const gpuHost = svc.gpuHost;
      const clip = await svc.openByUrl(video, salt);
      const info = svc.inspect(clip);
      const W = info.width, H = info.height;
      const sampleAt = async (idx: number) => {
        const h = await svc.pull(clip, idx);
        const px = await gpuHost.readbackTexture(h, W, H);
        const row = Math.floor(H / 2) * W * 4;
        let sum = 0, n = 0;
        for (let x = 0; x < W; x += 11) { sum += Math.max(px[row+x*4], px[row+x*4+1], px[row+x*4+2]); n++; }
        const rowArr = Array.from(px.slice(row, row + W * 4));
        return { lum: sum / n, rowArr };
      };
      // Scattered, out-of-order scrub — pure random access.
      const idxs = [0, Math.floor(info.frameCount * 0.6), Math.floor(info.frameCount * 0.25), Math.floor(info.frameCount * 0.85)];
      const samples = [];
      for (const i of idxs) samples.push(await sampleAt(i));
      const diff = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]-b[i]); return s; };
      return {
        codec: info.codec,
        minLum: Math.min(...samples.map(s => s.lum)),
        d01: diff(samples[0].rowArr, samples[1].rowArr),
        d12: diff(samples[1].rowArr, samples[2].rowArr),
      };
    }, { video: H264, salt: uniqueSalt('h264-seek') });

    // eslint-disable-next-line no-console
    console.log('[h264-seek] report:', JSON.stringify({ codec: r.codec, minLum: Math.round(r.minLum), d01: r.d01, d12: r.d12 }));
    expect(r.codec).toContain('(seek)');     // classified seekable, not streaming
    expect(r.minLum).toBeGreaterThan(8);     // no black frames from scrubbing
    expect(r.d01).toBeGreaterThan(1000);     // scattered seeks → distinct frames
    expect(r.d12).toBeGreaterThan(1000);
  });

  it('survives a full sequential sweep and loop-around without stalling', async () => {
    // Regression: non-DXV clips used to "conk out" on the first loop —
    // a no-op <video> seek (over-sampled frame rate) never fired `seeked`
    // and stalled the decode chain forever. This drives a long sweep past
    // the end then wraps back to 0, exactly the loop the IDE runs. If the
    // chain ever stalls, the page.evaluate hangs and the test times out.
    await boot();
    const result = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      const info = svc.inspect(clip);
      // CONSECUTIVE frames (stride 1) are what trigger the over-sampling
      // collision: with an assumed rate above the real one, neighbouring
      // requests land on the same underlying frame → no-op seek. Sweep a
      // bounded range, then wrap back to 0 — the first-loop case.
      const last = Math.min(info.frameCount - 1, 50);
      let pulled = 0;
      for (let i = 0; i <= last; i++) {
        const h = await svc.pull(clip, i);
        if (h > 0) pulled++;
      }
      for (let i = 0; i <= 10; i++) {          // wrap around to the start
        const h = await svc.pull(clip, i);
        if (h > 0) pulled++;
      }
      const tail = await svc.pull(clip, 0);
      return { pulled, tailOk: tail > 0, frameCount: info.frameCount };
    }, { video: H264, salt: uniqueSalt('h264-loop') });

    expect(result.pulled).toBeGreaterThan(20);   // made real progress, didn't stall
    expect(result.tailOk).toBe(true);            // still serving frames after the wrap
  });
});

describe('VideoPlaybackService — sparse-keyframe stress (Adobe Stock)', () => {
  jest.setTimeout(120_000);
  const CLIP = '/test-videos/AdobeStock_392085730.mov';

  async function boot() {
    await page.goto(RUNNER, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => { const w = (window as any).__videoService; return w && (w.status.ready || w.status.error); },
      { timeout: 45_000 });
    const status = await page.evaluate(() => (window as any).__videoService.status);
    if (status.error) throw new Error(`runner boot failed: ${status.error}`);
    await page.evaluate(() => (window as any).__videoService.resetIdb());
  }

  it('decodes a sequential sweep without black frames (diagnostic)', async () => {
    await boot();
    const report = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const gpuHost = svc.gpuHost;
      const clip = await svc.openByUrl(video, salt);
      const info = svc.inspect(clip);
      const W = info.width, H = info.height;
      const frames: Array<{ idx: number; ms: number; lum: number }> = [];
      // Pace at the SOURCE's reported fps — exactly what the IDE manager
      // now does. (Using a faster rate is the original bug: the playhead
      // outruns the <video>, forcing mid-GOP seeks that go black.)
      const frameMs = 1000 / info.fps;
      // Sequential sweep through the long opening GOP. Play-forward
      // sampling decodes these cleanly; the old seek-per-frame returned
      // black. Paced to real time so the <video> can actually roll.
      for (let i = 0; i <= 60; i++) {
        const t0 = performance.now();
        const h = await svc.pull(clip, i);
        const ms = performance.now() - t0;
        let lum = 0;
        if (h > 0) {
          const px = await gpuHost.readbackTexture(h, W, H);
          const row = Math.floor(H / 2) * W * 4;
          let sum = 0, n = 0;
          for (let x = 0; x < W; x += 9) { sum += Math.max(px[row+x*4], px[row+x*4+1], px[row+x*4+2]); n++; }
          lum = sum / n;
        }
        frames.push({ idx: i, ms, lum });
        const spent = performance.now() - t0;
        if (spent < frameMs) await new Promise(r => setTimeout(r, frameMs - spent));
      }
      const black = frames.filter(f => f.lum < 8).length;
      const maxMs = Math.max(...frames.map(f => f.ms));
      return {
        codec: info.codec, frameCount: info.frameCount, fps: info.fps,
        black, total: frames.length, maxMs,
        // last 10 frames' luminance to see the tail behaviour
        tailLum: frames.slice(-10).map(f => Math.round(f.lum)),
      };
    }, { video: CLIP, salt: uniqueSalt('adobe') });

    // eslint-disable-next-line no-console
    console.log('[adobe] report:', JSON.stringify(report));
    expect(report.frameCount).toBeGreaterThan(0);
    // fps must be measured near the real 24 — the IDE drives its loop at
    // this rate, so an over-estimate is what caused the black-out.
    expect(report.fps).toBeGreaterThanOrEqual(20);
    expect(report.fps).toBeLessThanOrEqual(30);
    // The goal: most frames decode to real content, not black.
    expect(report.black).toBeLessThanOrEqual(2);
  });

  it('keeps decoding past the loop wrap-around (no conk-out on loop 2)', async () => {
    // The reported bug: loop 1 plays, then it conks to black after the
    // first wrap. Stream the clip for longer than its full duration so we
    // cross the loop boundary, sampling luminance throughout — including
    // the frames AFTER the wrap, which used to go black.
    await boot();
    const report = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const gpuHost = svc.gpuHost;
      const clip = await svc.openByUrl(video, salt);
      const info = svc.inspect(clip);
      const W = info.width, H = info.height;
      const durationMs = (info.frameCount / info.fps) * 1000;
      const runMs = durationMs + 7000;        // well past the wrap into loop 2
      const frameMs = 1000 / info.fps;

      const start = performance.now();
      let idx = 0, sampled = 0, black = 0, sampledLate = 0, blackLate = 0;
      while (performance.now() - start < runMs) {
        const t0 = performance.now();
        const h = await svc.pull(clip, idx % info.frameCount);
        // Sample luminance every ~12th frame (2K readback is costly).
        if (idx % 12 === 0 && h > 0) {
          const px = await gpuHost.readbackTexture(h, W, H);
          const row = Math.floor(H / 2) * W * 4;
          let sum = 0, n = 0;
          for (let x = 0; x < W; x += 13) { sum += Math.max(px[row+x*4], px[row+x*4+1], px[row+x*4+2]); n++; }
          const lum = sum / n;
          sampled++; if (lum < 8) black++;
          // The native <video> loops at real time, so anything past the
          // clip's duration is loop 2+ — the regime that used to conk out.
          if (performance.now() - start > durationMs) { sampledLate++; if (lum < 8) blackLate++; }
        }
        idx++;
        const spent = performance.now() - t0;
        if (spent < frameMs) await new Promise(r => setTimeout(r, frameMs - spent));
      }
      return { sampled, black, sampledLate, blackLate };
    }, { video: CLIP, salt: uniqueSalt('adobe-loop') });

    // eslint-disable-next-line no-console
    console.log('[adobe-loop] report:', JSON.stringify(report));
    // Ran long enough to be into loop 2+ for a while.
    expect(report.sampledLate).toBeGreaterThan(5);
    // The crux: loop 2+ frames are NOT black — no conk-out.
    expect(report.blackLate).toBeLessThanOrEqual(1);
    expect(report.black / report.sampled).toBeLessThan(0.1);
  });
});

describe('FrameBlitter bridge (IDE integration path)', () => {
  jest.setTimeout(60_000);

  async function boot() {
    await page.goto(RUNNER, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => {
        const w = (window as any).__videoService;
        return w && (w.status.ready || w.status.error);
      },
      { timeout: 45_000 },
    );
    const status = await page.evaluate(() => (window as any).__videoService.status);
    if (status.error) throw new Error(`runner boot failed: ${status.error}`);
    await page.evaluate(() => (window as any).__videoService.resetIdb());
  }

  it('texture→ImageBitmap→re-upload preserves pixels and orientation', async () => {
    // This is the exact bridge the IDE uses: the main-thread service
    // decodes into a texture, FrameBlitter turns it into an ImageBitmap,
    // and the engine-worker re-uploads it. The round-trip must match the
    // directly-pulled texture (RGB; alpha is forced opaque by the canvas).
    await boot();
    const r = await page.evaluate(async ({ video, salt }) => {
      const svc = (window as any).__videoService;
      const clip = await svc.openByUrl(video, salt);
      return svc.blitRoundtrip(clip, 0);
    }, { video: VIDEO, salt: uniqueSalt('blit') });

    expect(r.direct.length).toBe(r.width * 4);
    expect(r.bridged.length).toBe(r.width * 4);

    // Compare RGB across the center row. If the blit flipped or shifted
    // the image, the rows would diverge wildly. A few codepoints of
    // tolerance covers the rgba8 round-trip.
    let maxDelta = 0;
    let sampled = 0;
    for (let x = 0; x < r.width; x += 7) {     // sparse sample, whole row
      for (let c = 0; c < 3; c++) {            // RGB only — alpha is forced opaque
        const d = Math.abs(r.direct[x * 4 + c] - r.bridged[x * 4 + c]);
        if (d > maxDelta) maxDelta = d;
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(100);
    expect(maxDelta).toBeLessThanOrEqual(4);
  });
});
