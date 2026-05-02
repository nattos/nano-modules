import { runGpuTest } from './gpu-test-helpers';

describe('Gradient Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuTest({
      module: 'gradient.wasm',
      bundle: 'core',
      dumpName: 'gradient_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('generator.gradient');
  });

  it('default white→black goes from white on left to black on right', async () => {
    // Defaults: angle=0 (horizontal), softness=1, color_a=white, color_b=black.
    const frame = await runGpuTest({
      module: 'gradient.wasm',
      bundle: 'core',
      width: 64, height: 64,
      samplePoints: [[2, 32], [61, 32]],
      dumpName: 'gradient_default',
    });
    expect(frame.success).toBe(true);
    const left = frame.samples.find(s => s.x === 2)!;
    const right = frame.samples.find(s => s.x === 61)!;
    expect(left.r).toBeGreaterThan(right.r);
  });

  it('softness=0 makes a sharp band at the centre', async () => {
    const frame = await runGpuTest({
      module: 'gradient.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [[0, 0.0], [1, 0.0], [2, 0.001]],  // angle 0, offset 0, softness ~0
      samplePoints: [[20, 32], [44, 32]],
      dumpName: 'gradient_sharp',
    });
    expect(frame.success).toBe(true);
    const left = frame.samples.find(s => s.x === 20)!;
    const right = frame.samples.find(s => s.x === 44)!;
    // Left of centre should be near color_a (white), right near color_b (black).
    expect(left.r).toBeGreaterThan(200);
    expect(right.r).toBeLessThan(50);
  });

  it('color_a override changes the start colour', async () => {
    // color_a = (1, 0, 0) red, color_b stays black, sharp band so we can sample.
    const frame = await runGpuTest({
      module: 'gradient.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [
        [0, 0.0], [1, 0.0], [2, 0.001],
        [3, 1.0], [4, 0.0], [5, 0.0],  // color_a = red
      ],
      samplePoints: [[5, 32]],
      dumpName: 'gradient_red_to_black',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(5, 32, { r: 255, g: 0, b: 0 }, 6);
  });
});
