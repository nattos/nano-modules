import { runGpuEffectTest, runGpuChainTest, runGpuTest, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for brightness_contrast — load the actual `core` bundle so
// changes to the shipping implementation are caught here. Chains with
// spinningtris use `testonly` (where spinningtris lives) since chain tests
// can mix bundles only by step.

forEachBackend((backend) => {
describe(`Brightness & Contrast Effect E2E (${backend})`, () => {
  jest.setTimeout(30000);

  describe('standalone (solid color input)', () => {
    it('declares metadata and I/O', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.tone.brightness_contrast',
        bundle: 'core',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        dumpName: 'bc_metadata',
      });

      expect(frame.success).toBe(true);
      expect(frame.metadata?.id).toBe('color.tone.brightness_contrast');
      expect(frame.params.length).toBe(2);
      expect(frame.params[0].name).toBe('brightness');
      expect(frame.params[1].name).toBe('contrast');
    });

    it('neutral settings pass through color unchanged', async () => {
      // brightness=0 (neutral), contrast=0 (1x) should pass through
      const frame = await runGpuEffectTest({
        module: 'color.tone.brightness_contrast',
        bundle: 'core',
        inputColor: [0.5, 0.25, 0.75, 1.0],
        params: [['brightness', 0.0], ['contrast', 0.0]],
        dumpName: 'bc_neutral',
      });

      expect(frame.success).toBe(true);
      // Input: (128, 64, 191, 255). With neutral settings, output should match.
      frame.expectPixelAt(32, 32, { r: 128, g: 64, b: 191, a: 255 }, 10);
    });

    it('contrast=-1 produces black', async () => {
      // contrast=-1 means multiply by (c+1)=0 → all black
      const frame = await runGpuEffectTest({
        module: 'color.tone.brightness_contrast',
        bundle: 'core',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        params: [['brightness', 0.0], ['contrast', -1.0]],
        dumpName: 'bc_contrast_zero',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 5);
    });

    it('contrast=1.0 doubles values', async () => {
      // contrast=1.0 means multiply by (c+1)=2.0
      // Input: 0.25 → 0.25 * 2.0 = 0.5 → 128 (brightness=0 neutral)
      const frame = await runGpuEffectTest({
        module: 'color.tone.brightness_contrast',
        bundle: 'core',
        inputColor: [0.25, 0.25, 0.25, 1.0],
        params: [['brightness', 0.0], ['contrast', 1.0]],
        dumpName: 'bc_contrast_double',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128, a: 255 }, 10);
    });

    it('brightness=1.0 maxes out white', async () => {
      // brightness=1.0 adds +1.0 to RGB, then contrast=0 (1x)
      // Input 0.0 + 1.0 = 1.0 → saturated white
      const frame = await runGpuEffectTest({
        module: 'color.tone.brightness_contrast',
        bundle: 'core',
        inputColor: [0.0, 0.0, 0.0, 1.0],
        params: [['brightness', 1.0], ['contrast', 0.0]],
        dumpName: 'bc_brightness_max',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 5);
    });

    it('brightness=-1 darkens by 1', async () => {
      // brightness=-1 adds -1.0 to RGB, then contrast=0 (1x)
      // Input 0.5 + (-1.0) = -0.5 → saturated to 0
      const frame = await runGpuEffectTest({
        module: 'color.tone.brightness_contrast',
        bundle: 'core',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        params: [['brightness', -1.0], ['contrast', 0.0]],
        dumpName: 'bc_brightness_min',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 5);
    });
  });

  describe('chain (spinningtris → brightness_contrast)', () => {
    // The chain runner loads a single bundle, so we use `testonly` here —
    // both spinningtris (test-only) and brightness_contrast (also present
    // in testonly as a duplicate) live there.
    it('reduces contrast when applied after spinningtris', async () => {
      // Render spinningtris alone
      const before = await runGpuTest({
        module: 'debug.spinningtris',
        width: 64, height: 64,
        // No params: debug.spinningtris declares no schema fields at all, so
        // the `[[0, 0.5]] // ~500 triangles` this used to pass was writing to a
        // param that has never existed. Dead on both backends.
        ticks: 5,
        dumpName: 'chain_before',
      });
      expect(before.success).toBe(true);

      // Render spinningtris → brightness_contrast with half contrast
      const after = await runGpuChainTest({
        chain: [
          { module: 'debug.spinningtris', ticks: 5 },  // no schema fields — see above
          { module: 'color.tone.brightness_contrast', params: [['brightness', 0.0], ['contrast', -0.5]] },
        ],
        width: 64, height: 64,
        dumpName: 'chain_half_contrast',
      });
      expect(after.success).toBe(true);

      // With contrast=-0.5 (multiply by 0.5), all pixel values should be halved
      // So the average brightness should be noticeably lower
      const beforeAvg = before.averageColor();
      const afterAvg = after.averageColor();
      expect(afterAvg.r).toBeLessThan(beforeAvg.r);
      expect(afterAvg.g).toBeLessThan(beforeAvg.g);
      expect(afterAvg.b).toBeLessThan(beforeAvg.b);

      // Frames should be visually different
      after.expectDifferentFrom(before, 50);
    });

    it('contrast=-1 in chain produces black', async () => {
      const frame = await runGpuChainTest({
        chain: [
          { module: 'debug.spinningtris', ticks: 5 },  // no schema fields — see above
          { module: 'color.tone.brightness_contrast', params: [['brightness', 0.0], ['contrast', -1.0]] },
        ],
        width: 64, height: 64,
        dumpName: 'chain_black',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 5);
    });
  });
});
});
