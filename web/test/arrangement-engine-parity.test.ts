/**
 * DUAL-BACKEND e2e ported from the app-driven engine suites — the cases in
 * `arrangement-layer-pipeline`, `arr-automation-drive` and `arrangement-real-chain`
 * that measure ENGINE behaviour rather than app plumbing.
 *
 * Those suites sample the DOM monitor after wall-clock waits; here the same
 * behaviours are asserted from fixed-step scenarios against both backends. The
 * originals stay as they are — they additionally cover the store/bridge/monitor
 * path, which has no native counterpart. See the header of
 * `arrangement-comp-mode-parity.test.ts` for the split.
 *
 * One deliberate change of seam: automation is driven by DOCUMENT lanes
 * (`clip.automation`, evaluated by comp_eval on both backends) rather than the
 * engine's per-frame `setAutomation` side channel, which is web-host-only and
 * therefore untestable natively.
 *
 *   cmake --build native/build --target comp_test_runner
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-engine-parity
 */

import { forEachBackend, runCompScenario, ensureCompRunnerPage } from './comp-test-helpers';
import {
  sceneTrackDoc,
  layerPipelineDoc,
  automationRampDoc,
  trackFxAutomationDoc,
  mkComposition,
  mkTrack,
  mkClip,
  mkDevice,
} from './fixtures/comp-docs';

forEachBackend((backend) => {
  describe(`Engine behaviour parity (${backend})`, () => {
    jest.setTimeout(180_000);

    beforeAll(async () => {
      if (backend === 'puppeteer') await ensureCompRunnerPage();
    });

    it('an effect clip processes the track above it (not a gray stand-in)', async () => {
      const run = await runCompScenario({
        doc: layerPipelineDoc(),
        width: 64,
        height: 64,
        ops: [{ seek: 42 }, { capture: 'composite' }],
      });

      const c = run.capture('composite');
      expect(c.hasContent).toBe(true);
      c.expectLayerCount(1);          // the noise layer; invert is effect-only
      // Still spatially varied ⇒ the invert really processed the noise from the
      // track above. A gray stand-in would be a flat fill (spread ≈ 0).
      expect(c.lumaSpread()).toBeGreaterThan(8);
    });

    it('a document automation lane drives a clip param across the clip span', async () => {
      const run = await runCompScenario({
        doc: automationRampDoc(),
        width: 32,
        height: 32,
        // The lane ramps over the clip's own 0..16 beat span.
        ops: [{ seek: 0.5 }, { capture: 'low' }, { seek: 15.5 }, { capture: 'high' }],
      });

      expect(run.capture('high').meanLuma())
        .toBeGreaterThan(run.capture('low').meanLuma() + 40);
    });

    it('a TRACK-level FX (per-track bus) is driven the same way', async () => {
      const run = await runCompScenario({
        doc: trackFxAutomationDoc(),
        width: 32,
        height: 32,
        ops: [{ seek: 0.5 }, { capture: 'low' }, { seek: 15.5 }, { capture: 'high' }],
      });

      // The track FX rendered AND the track-keyed automation drove it.
      expect(run.capture('high').meanLuma())
        .toBeGreaterThan(run.capture('low').meanLuma() + 40);
    });

    it('scene launch / switch / retrigger / stop lifecycle', async () => {
      const run = await runCompScenario({
        doc: sceneTrackDoc(),
        width: 32,
        height: 32,
        ops: [
          // Park on the base clip so there is always something composited.
          { seek: 42 },
          { capture: 'base' },
          { launch: { trackId: 't-scenes', sceneId: 's-red' } },
          { capture: 'red' },
          { launch: { trackId: 't-scenes', sceneId: 's-green' } },
          { capture: 'green' },
          // Re-launching the ACTIVE scene retriggers (re-anchors) it rather
          // than stopping it.
          { launch: { trackId: 't-scenes', sceneId: 's-green' } },
          { capture: 'retrigger' },
          { stopScene: { trackId: 't-scenes' } },
          { capture: 'stopped' },
        ],
      });

      // No scene playing before the first launch, or after the stop.
      expect(run.capture('base').playingScene('t-scenes')).toBeNull();
      expect(run.capture('red').playingScene('t-scenes')).toBe('s-red');
      expect(run.capture('green').playingScene('t-scenes')).toBe('s-green');
      expect(run.capture('retrigger').playingScene('t-scenes')).toBe('s-green');
      expect(run.capture('stopped').playingScene('t-scenes')).toBeNull();

      // …and the launched scene actually reaches the picture.
      const base = run.capture('base').centerPixel();
      const red = run.capture('red').centerPixel();
      const green = run.capture('green').centerPixel();
      expect(base.b).toBeGreaterThan(base.r);
      expect(red.r).toBeGreaterThan(red.g);
      expect(green.g).toBeGreaterThan(green.r);
      // Stopping returns the composite to the base layer exactly.
      expect(run.capture('stopped').diffBytes(run.capture('base'))).toBe(0);
    });

    it('renders a real effect chain and a param edit reaches the engine', async () => {
      const run = await runCompScenario({
        doc: mkComposition([
          mkTrack('t-1', [mkClip('c-1', 0, 16, [
            mkDevice('d-noise', 'source.noise'),
            mkDevice('d-bc', 'color.tone.brightness_contrast'),
            mkDevice('d-inv', 'color.invert'),
          ])]),
        ]),
        width: 64,
        height: 64,
        ops: [
          { seek: 1 },
          { capture: 'base' },
          { setParam: { ownerId: 'c-1', deviceId: 'd-bc', field: 'brightness', value: 0.9 } },
          { capture: 'edited' },
        ],
      });

      const base = run.capture('base');
      const edited = run.capture('edited');
      // A real 3-effect chain ran (the noise survives both stages).
      expect(base.lumaSpread()).toBeGreaterThan(8);
      // …and the param edit reached it.
      expect(edited.diffBytes(base)).toBeGreaterThan(0);
      expect(edited.chainKeys).toEqual(base.chainKeys);
    });
  });
});
