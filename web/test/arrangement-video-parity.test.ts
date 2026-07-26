/**
 * DUAL-BACKEND video e2e — a real DXV clip decoded and composited by BOTH
 * hosts, from one scenario.
 *
 * Web decodes through `VideoPlaybackService` (dxv-decoder.ts + WebGPU BC1);
 * native decodes through `nano_media::VideoPump` (the same dxv_demux/dxv_lz
 * sources + a Metal BC1 blit). The cache, cost tracker, access classifier and
 * read-ahead are lock-step twins (native/src/media/*.h ↔ web/src/video/*.ts,
 * pinned by video-policy-goldens.test.ts), so the decode POLICY is the same on
 * both sides even where the plumbing isn't.
 *
 * What is NOT asserted here: byte-identical pixels. The two hosts run different
 * BC1 decode hardware paths and different samplers for the placement blit, so
 * the frames agree structurally (same source frame, same placement, same
 * luminance) rather than bit-for-bit. The bit-exact comparisons live in the
 * non-video parity suites, where both hosts run the identical shader.
 *
 *   cmake --build native/build --target comp_test_runner
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-video-parity
 */

import { forEachBackend, runCompScenario, ensureCompRunnerPage } from './comp-test-helpers';
import { videoDoc, videoClip, mkComposition, mkTrack } from './fixtures/comp-docs';

/** A video scenario needs at least two steps before a capture: both runners
 *  pump on the PREVIOUS frame's position, so the first step after a seek
 *  renders before anything has been decoded. See either runner's `step`. */
const SETTLE = { play: { frames: 2, dtSec: 1 / 60 } };

forEachBackend((backend) => {
  describe(`DXV video parity (${backend})`, () => {
    jest.setTimeout(240_000);

    beforeAll(async () => {
      if (backend === 'puppeteer') await ensureCompRunnerPage();
    });

    it('decodes a DXV clip and composites it', async () => {
      const run = await runCompScenario({
        doc: videoDoc(),
        width: 64,
        height: 64,
        ops: [{ seek: 0 }, SETTLE, { capture: 'frame' }],
      });

      run.expectNothingSkipped();
      const c = run.capture('frame');
      expect(c.hasContent).toBe(true);
      c.expectLayerCount(1);
      // Real decoded picture: lit, and spatially varied. A failed decode leaves
      // the frame transparent (the effect clears when nothing is bound), and a
      // mis-strided BC1 upload would still be varied — hence both checks plus
      // the frame-advance assertion below.
      expect(c.meanLuma()).toBeGreaterThan(4);
      expect(c.lumaSpread()).toBeGreaterThan(8);
    });

    it('advances through the file as the transport plays', async () => {
      const run = await runCompScenario({
        doc: videoDoc(),
        width: 64,
        height: 64,
        ops: [
          { seek: 0 }, SETTLE, { capture: 'early' },
          // 2 beats at 120 BPM = 1 second = ~30 source frames.
          { play: { frames: 60, dtSec: 1 / 60 } }, { capture: 'later' },
        ],
      });

      run.expectNothingSkipped();
      const early = run.capture('early');
      const later = run.capture('later');
      // A different source frame reached the screen — the clip is PLAYING, not
      // pinned on its entry frame (which is what a broken beat→frame map or a
      // stuck cache looks like).
      expect(later.diffBytes(early)).toBeGreaterThan(early.pixels.length / 50);
      expect(later.lumaSpread()).toBeGreaterThan(8);
    });

    it('reports decode telemetry with a warm cache', async () => {
      const run = await runCompScenario({
        doc: videoDoc(),
        width: 64,
        height: 64,
        ops: [{ seek: 0 }, { play: { frames: 60, dtSec: 1 / 60 } }, { capture: 'end' }],
      });

      run.expectNothingSkipped();
      const t = run.videoClips['v1'];
      expect(t).toBeDefined();
      // Sequential playback at 60 Hz over a 30 fps file: every source frame is
      // pulled twice, so a working cache serves most requests. This is the
      // measurement the perf suite gates on — assert it MOVES, not its exact
      // value (the hosts' prefetch scheduling differs; the policy doesn't).
      expect(t.cacheHits as number).toBeGreaterThan(10);
      expect(t.cachedFrames as number).toBeGreaterThan(0);
    });

    it('a one-shot clip past its end renders transparent, not a frozen frame', async () => {
      const run = await runCompScenario({
        doc: mkComposition([
          mkTrack('t-vid', [videoClip('v1', 0, 64, 'test_dxv.mov', {
            loop: { mode: 'one-shot', startSec: 0, speed: 1, direction: 'forward' },
          })]),
        ]),
        width: 64,
        height: 64,
        ops: [
          { seek: 0 }, SETTLE, { capture: 'playing' },
          // Far past the file's duration: one-shot maps off the end.
          { seek: 60 }, SETTLE, { capture: 'past-end' },
        ],
      });

      run.expectNothingSkipped();
      expect(run.capture('playing').meanLuma()).toBeGreaterThan(4);
      // Nothing bound → the effect clears to transparent → black composite.
      expect(run.capture('past-end').meanLuma()).toBeLessThan(2);
    });

    it('names any clip it cannot decode instead of rendering a hole', async () => {
      const run = await runCompScenario({
        doc: videoDoc('test_h264.mp4'),
        width: 64,
        height: 64,
        ops: [{ seek: 0 }, SETTLE, { capture: 'frame' }],
      });

      // h264 is web-only today (native is DXV-first; AVFoundation is the
      // follow-up). Whatever a backend can't handle must be REPORTED.
      const skipped = run.videoSkipped;
      if (backend === 'metal') {
        expect(Object.keys(skipped)).toEqual(['v1']);
        expect(skipped['v1']).toMatch(/not a DXV stream/);
      }
    });
  });
});
