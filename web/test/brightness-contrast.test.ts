import { runGpuEffectTest, runGpuChainTest, runGpuTest } from './gpu-test-helpers';

describe('Brightness/Contrast Effect E2E', () => {
  jest.setTimeout(30000);

  describe('standalone (solid color input)', () => {
    it('declares metadata and I/O', async () => {
      const frame = await runGpuEffectTest({
        module: 'brightness_contrast.wasm',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        dumpName: 'bc_metadata',
      });

      expect(frame.success).toBe(true);
      expect(frame.metadata?.id).toBe('com.nattos.brightness_contrast');
      expect(frame.params.length).toBe(2);
      expect(frame.params[0].name).toBe('brightness');
      expect(frame.params[1].name).toBe('contrast');
    });

    it('neutral settings pass through color unchanged', async () => {
      // brightness=0.5 (neutral), contrast=0.5 (1x) should pass through
      const frame = await runGpuEffectTest({
        module: 'brightness_contrast.wasm',
        inputColor: [0.5, 0.25, 0.75, 1.0],
        params: [[0, 0.5], [1, 0.5]],
        dumpName: 'bc_neutral',
      });

      expect(frame.success).toBe(true);
      // Input: (128, 64, 191, 255). With neutral settings, output should match.
      frame.expectPixelAt(32, 32, { r: 128, g: 64, b: 191, a: 255 }, 10);
    });

    it('contrast=0 produces black', async () => {
      // contrast=0 means multiply by 0 → all black
      const frame = await runGpuEffectTest({
        module: 'brightness_contrast.wasm',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        params: [[0, 0.5], [1, 0.0]],
        dumpName: 'bc_contrast_zero',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 5);
    });

    it('contrast=1.0 doubles values', async () => {
      // contrast=1.0 means multiply by 2.0
      // Input: 0.25 → 0.25 * 2.0 = 0.5 → 128
      const frame = await runGpuEffectTest({
        module: 'brightness_contrast.wasm',
        inputColor: [0.25, 0.25, 0.25, 1.0],
        params: [[0, 0.5], [1, 1.0]],
        dumpName: 'bc_contrast_double',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128, a: 255 }, 10);
    });

    it('brightness=1.0 maxes out white', async () => {
      // brightness=1.0 adds +1.0 to RGB, then contrast=0.5 (1x)
      // Input 0.0 + 1.0 = 1.0 → saturated white
      const frame = await runGpuEffectTest({
        module: 'brightness_contrast.wasm',
        inputColor: [0.0, 0.0, 0.0, 1.0],
        params: [[0, 1.0], [1, 0.5]],
        dumpName: 'bc_brightness_max',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 5);
    });

    it('brightness=0 darkens by -1', async () => {
      // brightness=0 adds -1.0 to RGB, then contrast=0.5 (1x)
      // Input 0.5 + (-1.0) = -0.5 → saturated to 0
      const frame = await runGpuEffectTest({
        module: 'brightness_contrast.wasm',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        params: [[0, 0.0], [1, 0.5]],
        dumpName: 'bc_brightness_min',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 5);
    });
  });

  describe('chain (spinningtris → brightness_contrast)', () => {
    it('reduces contrast when applied after spinningtris', async () => {
      // Render spinningtris alone
      const before = await runGpuTest({
        module: 'spinningtris.wasm',
        width: 64, height: 64,
        params: [[0, 0.5]], // ~500 triangles
        ticks: 5,
        dumpName: 'chain_before',
      });
      expect(before.success).toBe(true);

      // Render spinningtris → brightness_contrast with half contrast
      const after = await runGpuChainTest({
        chain: [
          { module: 'spinningtris.wasm', params: [[0, 0.5]], ticks: 5 },
          { module: 'brightness_contrast.wasm', params: [[0, 0.5], [1, 0.25]] },
        ],
        width: 64, height: 64,
        dumpName: 'chain_half_contrast',
      });
      expect(after.success).toBe(true);

      // With contrast=0.25 (multiply by 0.5), all pixel values should be halved
      // So the average brightness should be noticeably lower
      const beforeAvg = before.averageColor();
      const afterAvg = after.averageColor();
      expect(afterAvg.r).toBeLessThan(beforeAvg.r);
      expect(afterAvg.g).toBeLessThan(beforeAvg.g);
      expect(afterAvg.b).toBeLessThan(beforeAvg.b);

      // Frames should be visually different
      after.expectDifferentFrom(before, 50);
    });

    it('contrast=0 in chain produces black', async () => {
      const frame = await runGpuChainTest({
        chain: [
          { module: 'spinningtris.wasm', params: [[0, 0.5]], ticks: 5 },
          { module: 'brightness_contrast.wasm', params: [[0, 0.5], [1, 0.0]] },
        ],
        width: 64, height: 64,
        dumpName: 'chain_black',
      });

      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 5);
    });
  });
});
