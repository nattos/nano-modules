import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.posterize` against `core`.
// amount [0, 1] maps exponentially to a number of levels: 0→256, 1→2.
// Param indices: 0 = amount, 1 = quantize_alpha.

describe('Posterize Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.posterize',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'posterize_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.posterize');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['amount', 'quantize_alpha']);
  });

  it('amount=0 leaves the image essentially unchanged', async () => {
    // 256 levels — 8-bit input is already at that resolution.
    const frame = await runGpuEffectTest({
      module: 'color.posterize',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [[0, 0.0]],
      dumpName: 'posterize_off',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('amount=1 collapses each channel to 2 levels (black/white)', async () => {
    // Mid-grey 0.5 → round(0.5 * 1) / 1 = 1 → 255
    const frame = await runGpuEffectTest({
      module: 'color.posterize',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[0, 1.0]],
      dumpName: 'posterize_max',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 255, g: 255, b: 255, a: 255 }, 2);
  });

  it('amount=1 sends below-mid greys to black', async () => {
    // 0.4 * 1 = 0.4 → round 0 → 0
    const frame = await runGpuEffectTest({
      module: 'color.posterize',
      bundle: 'core',
      inputColor: [0.4, 0.4, 0.4, 1.0],
      params: [[0, 1.0]],
      dumpName: 'posterize_max_low',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 4);
  });

  it('quantize_alpha=0 leaves alpha continuous', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.posterize',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.5],
      params: [[0, 1.0], [1, 0.0]],
      dumpName: 'posterize_alpha_continuous',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 128 }, 4);
  });

  it('quantize_alpha=1 also snaps alpha to the same levels', async () => {
    // 0.5 alpha at 2 levels → 1.0 → 255
    const frame = await runGpuEffectTest({
      module: 'color.posterize',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.5],
      params: [[0, 1.0], [1, 1.0]],
      dumpName: 'posterize_alpha_quantized',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 255 }, 4);
  });
});
