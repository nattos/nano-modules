/**
 * DUAL-BACKEND offline export — the same composition rendered to a planned
 * frame grid by both hosts.
 *
 * Offline export is the one path with no realtime pacing at all: every frame is
 * a seek to a planned beat with its media injected first, then a render. So the
 * two hosts should agree on the frame COUNT exactly and on the content of each
 * frame closely — which is what makes this the strongest end-to-end check in
 * the suite.
 *
 * The frame grid itself is a lock-step pair: `planExportFrames` in
 * export-renderer.ts ↔ native/src/sketch/comp/export_plan.h. Frames are walked
 * in real (warped) SECONDS so the output cadence is uniform in time.
 *
 * Scope, on both sides: frame-accurate RENDERING. No muxing — that would test
 * an encoder, not the compositor.
 *
 *   cmake --build native/build --target comp_test_runner
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-export-parity
 */

import { forEachBackend, runCompScenario, ensureCompRunnerPage } from './comp-test-helpers';
import {
  layeredCompositeDoc, layerPipelineDoc, videoDoc, mkComposition, mkTrack, mkClip, mkDevice,
} from './fixtures/comp-docs';

forEachBackend((backend) => {
  describe(`offline export parity (${backend})`, () => {
    jest.setTimeout(300_000);

    beforeAll(async () => {
      if (backend === 'puppeteer') await ensureCompRunnerPage();
    });

    it('renders exactly the planned number of frames', async () => {
      const run = await runCompScenario({
        // The layered fixture spans beats 40..48, so export a window INSIDE it.
        doc: layeredCompositeDoc(),
        width: 64,
        height: 64,
        ops: [],
        export: { fps: 30, startBeat: 40, endBeat: 42 },
      });

      const ex = run.exported;
      // 2 beats at 120 BPM = 1 s ⇒ 30 frames. Same arithmetic on both sides.
      expect(ex.frames).toBe(30);
      expect(ex.frameStats).toHaveLength(30);
      expect(ex.fps).toBe(30);
      expect(ex.durationSec).toBeCloseTo(1, 6);
      // Every frame had content: the clips cover the whole exported window.
      expect(ex.engineFrames).toBe(30);
      // …and the frames march forward in time, one 1/fps step at a time.
      for (let i = 1; i < ex.frameStats.length; i++) {
        expect(ex.frameStats[i].beat).toBeGreaterThan(ex.frameStats[i - 1].beat);
      }
      expect(ex.frameStats[0].beat).toBeCloseTo(40, 6);
      expect(ex.frameStats[29].beat).toBeCloseTo(41.9333, 3);
    });

    it('an empty stretch of timeline still emits frames, without content', async () => {
      const run = await runCompScenario({
        // One clip at 40..48; export the empty region before it.
        doc: layeredCompositeDoc(),
        width: 64,
        height: 64,
        ops: [],
        export: { fps: 10, startBeat: 0, endBeat: 2 },
      });

      const ex = run.exported;
      expect(ex.frames).toBe(10);
      // A gap in the timeline still STEPS — the exporter must not stall or
      // silently drop frames, or the output would be short and out of sync.
      expect(ex.engineFrames).toBe(0);
      for (const f of ex.frameStats) expect(f.meanLuma).toBeLessThan(2);
    });

    it('renders a real effect chain per frame', async () => {
      const run = await runCompScenario({
        doc: layerPipelineDoc(),
        width: 64,
        height: 64,
        ops: [],
        export: { fps: 12, startBeat: 40, endBeat: 41 },
      });

      const ex = run.exported;
      expect(ex.frames).toBe(6);
      expect(ex.engineFrames).toBe(6);
      // The inverted noise is lit on every frame — a stand-in or an empty chain
      // would read ~0.
      for (const f of ex.frameStats) expect(f.meanLuma).toBeGreaterThan(20);
    });

    it('exports a video clip frame by frame', async () => {
      const run = await runCompScenario({
        doc: videoDoc(),
        width: 64,
        height: 64,
        ops: [],
        export: { fps: 15, startBeat: 0, endBeat: 2 },
      });

      run.expectNothingSkipped();
      const ex = run.exported;
      expect(ex.frames).toBe(15);
      // Unlike the realtime path, export injects BEFORE the seek — so frame 0
      // already has its decoded picture, with no warm-up steps.
      expect(ex.frameStats[0].meanLuma).toBeGreaterThan(4);
      expect(ex.engineFrames).toBe(15);
      // The source advances across the export: the luma trace can't be constant.
      const lumas = ex.frameStats.map((f) => f.meanLuma);
      expect(Math.max(...lumas) - Math.min(...lumas)).toBeGreaterThan(0.05);
    });

    it('honours the composition tempo when planning the grid', async () => {
      const run = await runCompScenario({
        doc: mkComposition([
          mkTrack('t-1', [mkClip('c-1', 0, 64, [
            mkDevice('d-1', 'source.solid_color', { color: [0.5, 0.5, 0.5] }),
          ])]),
        ], { meta: {
          resolution: { width: 1920, height: 1080 },
          baseBPM: 60, timeSignature: [4, 4],
        } }),
        width: 32,
        height: 32,
        ops: [],
        export: { fps: 10, startBeat: 0, endBeat: 4 },
      });

      // 4 beats at 60 BPM = 4 s ⇒ 40 frames (the same window at 120 BPM would
      // be 20). The plan walks SECONDS, so tempo really moves the frame count.
      expect(run.exported.frames).toBe(40);
    });
  });
});
