import { runGpuTest } from './gpu-test-helpers';

describe('GPU Pipeline E2E', () => {
  jest.setTimeout(30000);

  describe('gpu_test module (solid color fill)', () => {
    it('fills entire frame with compute-generated color', async () => {
      const frame = await runGpuTest({
        module: 'gpu_test.wasm',
        dumpName: 'gpu_test_solid',
      });

      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('gpu_test: initialized');

      // Compute shader sets R=0.0, G=0.5, B=1.0 → (0, 128, 255, 255)
      frame.expectPixelAt(32, 32, { r: 0, g: 128, b: 255, a: 255 });
      frame.expectUniformColor({ r: 0, g: 128, b: 255, a: 255 });
    });

    it('corners match center', async () => {
      const frame = await runGpuTest({
        module: 'gpu_test.wasm',
        dumpName: 'gpu_test_corners',
      });

      const center = frame.pixelAt(32, 32);
      frame.expectPixelAt(0, 0, center);
      frame.expectPixelAt(63, 0, center);
      frame.expectPixelAt(0, 63, center);
      frame.expectPixelAt(63, 63, center);
    });
  });

  describe('spinningtris module', () => {
    it('renders colored triangles', async () => {
      const frame = await runGpuTest({
        module: 'spinningtris.wasm',
        width: 128,
        height: 128,
        params: [[0, 0.5]], // ~500 triangles
        ticks: 10,
        dumpName: 'spinningtris_render',
      });

      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('SpinningTris: GPU initialized');

      // Should have some non-background pixels (triangles)
      const bg = { r: 13, g: 13, b: 20 };
      frame.expectNotSolidColor(bg);

      // Coverage: at least 5% of pixels should be non-background
      frame.expectCoverage(
        c => c.r > 25 || c.g > 25 || c.b > 30,
        { min: 0.05 },
      );
    });

    it('more triangles = more coverage', async () => {
      const few = await runGpuTest({
        module: 'spinningtris.wasm',
        width: 128, height: 128,
        params: [[0, 0.01]], // ~10 triangles
        ticks: 5,
        dumpName: 'spinningtris_few',
      });

      const many = await runGpuTest({
        module: 'spinningtris.wasm',
        width: 128, height: 128,
        params: [[0, 1.0]], // 1000 triangles
        ticks: 5,
        dumpName: 'spinningtris_many',
      });

      const isColored = (c) => c.r > 25 || c.g > 25 || c.b > 30;
      expect(many.coverage(isColored)).toBeGreaterThan(few.coverage(isColored));
    });

    it('animation changes frame over time', async () => {
      const t0 = await runGpuTest({
        module: 'spinningtris.wasm',
        width: 64, height: 64,
        params: [[0, 0.5]],
        ticks: 1,
        dumpName: 'spinningtris_t0',
      });

      const t60 = await runGpuTest({
        module: 'spinningtris.wasm',
        width: 64, height: 64,
        params: [[0, 0.5]],
        ticks: 60,
        dumpName: 'spinningtris_t60',
      });

      // Frames at different times should look different (triangles rotate)
      t60.expectDifferentFrom(t0, 50);
    });

    it('declares expected parameters', async () => {
      const frame = await runGpuTest({
        module: 'spinningtris.wasm',
        dumpName: 'spinningtris_params',
      });

      expect(frame.success).toBe(true);
      expect(frame.params.length).toBe(2);
      const paramNames = frame.params.map((p: any) => p.name).sort();
      expect(paramNames).toEqual(['speed', 'triangles']);
      expect(frame.metadata?.id).toBe('com.nattos.spinningtris');
    });
  });
});
