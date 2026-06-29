/**
 * Video-provider STALL BENCHMARK.
 *
 * Loads an arrangement of several video clips spanning multiple codecs and play
 * modes, plays through it in Precise transport mode, and records how often the
 * transport STALLS — i.e. a frame where playback wanted to advance but the
 * video provider hadn't decoded the current-beat picture yet
 * (`store.playing && !engineBridge.inputsReady()`). Precise mode HOLDS the
 * playhead on an unready frame (time never runs ahead of the picture), so a
 * stall frame is a real, user-visible hitch — the metric we want to drive down.
 *
 * Codecs exercised:
 *   - <video> cursor path: H.264 mp4, VP9 webm, VP8 webm  (browser-decoded)
 *   - service FrameSource path: DXV .mov                  (app-decoded, headless-OK)
 * Play modes: time / one-shot / beat-sync / random (random stresses seeks).
 *
 * This is a BENCHMARK, not a pass/fail correctness test: it asserts only that the
 * pipeline ran to completion without deadlocking and that decode actually
 * happened, then prints a detailed report (stall %, episodes, per-clip provider
 * stats: decode path, inject FPS, seeks, cache hit rate). Use it to compare
 * before/after as the video pipeline evolves.
 *
 *   # generate the test media once (gitignored under public/test-videos/bench/):
 *   python3 test/fixtures/gen_bench_media.py
 *   # then, against a running dev server:
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest video-stall-benchmark
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;
const BENCH = `${BASE}/test-videos/bench`;

// Cursor-path clips come from the generated manifest; DXV is an existing
// service-path fixture under public/media/.
interface Media { key: string; url: string; codec: string; path: 'cursor' | 'service'; fps: number; frames: number; w: number; h: number }
const DXV: Media = { key: 'dxv', url: `${BASE}/media/test_dxv.mov`, codec: 'dxv', path: 'service', fps: 30, frames: 57, w: 1280, h: 720 };

type Mode = 'time' | 'one-shot' | 'beat-sync' | 'random';
interface Placement { media: string; startBeat: number; lengthBeat: number; mode: Mode }

// 3 tracks, staggered so 2–3 videos decode simultaneously at most playhead
// positions. Span ≈ 0..36 beats (18 s @ 120 BPM). Each codec appears ≥ once and
// each play mode is exercised.
const LAYOUT: Placement[][] = [
  [
    { media: 'h264_720', startBeat: 0, lengthBeat: 8, mode: 'time' },
    { media: 'vp9_720', startBeat: 8, lengthBeat: 8, mode: 'beat-sync' },
    { media: 'h264_1080', startBeat: 16, lengthBeat: 8, mode: 'time' },
    { media: 'dxv', startBeat: 24, lengthBeat: 8, mode: 'random' },
  ],
  [
    { media: 'vp8_480', startBeat: 4, lengthBeat: 8, mode: 'one-shot' },
    { media: 'dxv', startBeat: 12, lengthBeat: 8, mode: 'time' },
    { media: 'h264_longgop', startBeat: 20, lengthBeat: 8, mode: 'one-shot' },
    { media: 'vp9_720', startBeat: 28, lengthBeat: 8, mode: 'time' },
  ],
  [
    { media: 'h264_720', startBeat: 0, lengthBeat: 10, mode: 'random' },
    { media: 'h264_1080', startBeat: 10, lengthBeat: 10, mode: 'time' },
    { media: 'vp8_480', startBeat: 20, lengthBeat: 8, mode: 'beat-sync' },
  ],
];

describe('Video provider stall benchmark', () => {
  jest.setTimeout(150_000);

  it('plays a multi-codec, multi-play-mode arrangement and records stalls', async () => {
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

    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!(window as any).arrangementStore && !!(window as any).__engineBridge, { timeout: 20_000 });

    // Require the generated media (fail loud with the fix, don't silently no-op).
    const manifest = await page.evaluate(async (b) => {
      try {
        const r = await fetch(`${b}/manifest.json`);
        if (!r.ok) return null;
        return (await r.json()) as Array<{ file: string; codec: string; fps: number; frames: number; w: number; h: number }>;
      } catch { return null; }
    }, BENCH);
    if (!manifest) throw new Error(`bench media missing — run: python3 test/fixtures/gen_bench_media.py  (expected at ${BENCH}/manifest.json)`);

    const MEDIA: Record<string, Media> = { dxv: DXV };
    for (const m of manifest) {
      // bench_h264_720p30.mp4 → h264_720 ; bench_h264_longgop.mp4 → h264_longgop
      const key = m.file.replace(/^bench_/, '').replace(/\.\w+$/, '').replace(/p\d+$/, '');
      MEDIA[key] = { key, url: `${BENCH}/${m.file}`, codec: m.codec, path: 'cursor', fps: m.fps, frames: m.frames, w: m.w, h: m.h };
    }

    // Wait for the engine to boot + discover source.video.file (else clips are empty).
    await page.waitForFunction(() => (window as any).__engineBridge?.isBooted, { timeout: 30_000 });
    await page.waitForFunction(
      () => ((window as any).__engineBridge?.discoveredEffects?.() ?? []).includes('source.video.file'),
      { timeout: 30_000 },
    );

    // Build the arrangement + arm telemetry. Returns the end beat to play to.
    const endBeat = await page.evaluate((args) => {
      const { layout, media } = args as { layout: Placement[][]; media: Record<string, Media> };
      const store = (window as any).arrangementStore;
      (window as any).__debugPerf.active = true; // populate per-clip provider stats

      let end = 0;
      for (const lane of layout) {
        const trackId = store.addTrack();
        for (const p of lane) {
          const m = media[p.media];
          if (!m) throw new Error(`unknown media key ${p.media}`);
          const path = store.addVideoClip(
            trackId, p.startBeat,
            { sourceKey: `${m.key}:${p.startBeat}`, url: m.url, frameCount: m.frames, fps: m.fps, width: m.w, height: m.h, label: `${m.codec} ${p.mode}` },
            p.lengthBeat,
          );
          if (!path) throw new Error(`addVideoClip failed for ${p.media}`);
          const [, , clipId] = path.split('/');
          const patch: any = { mode: p.mode };
          if (p.mode === 'beat-sync') patch.syncBeats = p.lengthBeat;
          store.updateClipLoop(trackId, clipId, patch);
          end = Math.max(end, p.startBeat + p.lengthBeat);
        }
      }

      store.setTransportMode('precise');
      store.setPosition(0);
      return end;
    }, { layout: LAYOUT, media: MEDIA });

    // Give the lookahead precache a moment to start opening the first clips.
    await new Promise((r) => setTimeout(r, 1500));

    // Arm an rAF-cadence stall sampler (same predicate + granularity the transport
    // tick gates on), then start playback.
    await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const bridge = (window as any).__engineBridge;
      const acc: any = {
        frames: 0, stallFrames: 0, episodes: 0, decodePendingFrames: 0,
        byState: { idle: 0, stalled: 0, streaming: 0 },
        inStall: false, stopped: false, t0: performance.now(), tEnd: performance.now(),
      };
      (window as any).__stallBench = acc;
      // Per-clip provider stats accumulate across the run (keyed by clip label),
      // taking the MAX of each window-reset counter + whether the clip ever injected.
      const clipAgg: Record<string, any> = {};
      acc.clipAgg = clipAgg;
      const tick = () => {
        if (acc.stopped) return;
        if (store.playing) {
          acc.frames++;
          // The app's own per-frame disk classification is authoritative: 'stalled'
          // = Precise mode holding the playhead on an undecoded video input.
          const stalled = store.diskState === 'stalled';
          if (stalled) { acc.stallFrames++; if (!acc.inStall) { acc.episodes++; acc.inStall = true; } }
          else acc.inStall = false;
          if (bridge.decodePending()) acc.decodePendingFrames++;
          acc.byState[store.diskState] = (acc.byState[store.diskState] || 0) + 1;
          for (const c of (window as any).__debugPerf.clips ?? []) {
            const a = clipAgg[c.label] ?? (clipAgg[c.label] = { label: c.label, path: c.path, w: c.width, h: c.height, injectEver: 0, seeks: 0, notReady: 0, cacheHitRate: null });
            a.path = c.path; a.w = c.width; a.h = c.height;
            a.injectEver += (c.injectN ?? 0);
            a.seeks = Math.max(a.seeks, c.seeks ?? 0);
            a.notReady = Math.max(a.notReady, c.notReady ?? 0);
            if (c.cacheHitRate != null) a.cacheHitRate = Math.round(c.cacheHitRate * 100);
          }
        }
        acc.tEnd = performance.now();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      if (!store.playing) store.togglePlay();
    });

    // Play for a fixed wall-clock budget. Precise mode HOLDS the playhead on an
    // unready frame, so heavy stalls show up as low realtime coverage (beats
    // advanced vs nominal) — a deterministic headline that always completes,
    // rather than waiting indefinitely for the playhead to clear every clip.
    const BUDGET_MS = 30_000;
    await new Promise((r) => setTimeout(r, BUDGET_MS));

    const report = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const acc = (window as any).__stallBench;
      acc.stopped = true;
      if (store.playing) store.togglePlay();
      return {
        positionBeat: +store.positionBeat.toFixed(2),
        baseBPM: store.composition.meta.baseBPM,
        frames: acc.frames, stallFrames: acc.stallFrames, episodes: acc.episodes,
        decodePendingFrames: acc.decodePendingFrames, byState: acc.byState,
        wallSec: +((acc.tEnd - acc.t0) / 1000).toFixed(2),
        clips: Object.values(acc.clipAgg),
      };
    });

    const stallPct = report.frames ? (100 * report.stallFrames / report.frames) : 0;
    const nominalBeatsPerSec = report.baseBPM / 60;
    const beatsPerSec = report.wallSec ? report.positionBeat / report.wallSec : 0;
    const realtimePct = nominalBeatsPerSec ? (100 * beatsPerSec / nominalBeatsPerSec) : 0;
    /* eslint-disable no-console */
    console.log('\n┌─ VIDEO PROVIDER STALL BENCHMARK ──────────────────────────────');
    console.log(`│ ${LAYOUT.flat().length} clips / ${LAYOUT.length} tracks, span ${endBeat} beats, Precise mode`);
    console.log(`│ advanced to beat ${report.positionBeat} in ${report.wallSec}s → ${beatsPerSec.toFixed(2)} beat/s vs ${nominalBeatsPerSec.toFixed(2)} nominal = ${realtimePct.toFixed(0)}% realtime`);
    console.log(`│ STALLS: ${report.episodes} episodes, ${report.stallFrames}/${report.frames} frames (${stallPct.toFixed(1)}%)`);
    console.log(`│ decode-pending frames: ${report.decodePendingFrames}   disk state: ${JSON.stringify(report.byState)}`);
    console.log('│ per-clip provider stats (max over run):');
    for (const c of report.clips as any[]) {
      console.log(`│   ${String(c.label).padEnd(20)} ${String(c.path).padEnd(7)} ${c.w}x${c.h}  injected=${c.injectEver > 0 ? 'Y' : 'n'} seeks=${c.seeks} notReady=${c.notReady} cacheHit=${c.cacheHitRate ?? '–'}%`);
    }
    console.log('└───────────────────────────────────────────────────────────────\n');
    /* eslint-enable no-console */

    // Soft gates: the pipeline ran (frames sampled) and the transport made real
    // progress (decode happened on at least one path — a fully-deadlocked
    // provider would never advance). Stall COUNT is the reported benchmark
    // number, not asserted (environment-dependent).
    expect(report.frames).toBeGreaterThan(0);
    expect(report.positionBeat).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  });
});
