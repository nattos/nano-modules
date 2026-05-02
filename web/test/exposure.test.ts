import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.exposure` against `core`. amount [-1, +1]
// maps to ±3 stops (gain 1/8 .. 8). Tint params (warmth, amount) shift
// the per-channel gain when tint_amount > 0.
//
// Param indices (declaration order):
//   0 = amount, 1 = tint_warmth, 2 = tint_amount

describe('Exposure Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'exposure.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'exposure_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.exposure');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['amount', 'tint_amount', 'tint_warmth']);
  });

  it('amount=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'exposure.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.4, 0.4, 1.0],
      params: [[0, 0.0]],
      dumpName: 'exposure_zero',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 102, b: 102, a: 255 }, 4);
  });

  it('amount=+1 multiplies by 8 (saturates white)', async () => {
    // 0.1 * 8 = 0.8 → 204
    const frame = await runGpuEffectTest({
      module: 'exposure.wasm',
      bundle: 'core',
      inputColor: [0.1, 0.1, 0.1, 1.0],
      params: [[0, 1.0]],
      dumpName: 'exposure_lift',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 204, g: 204, b: 204, a: 255 }, 4);
  });

  it('amount=-1 multiplies by 1/8', async () => {
    // 0.8 / 8 = 0.1 → 26
    const frame = await runGpuEffectTest({
      module: 'exposure.wasm',
      bundle: 'core',
      inputColor: [0.8, 0.8, 0.8, 1.0],
      params: [[0, -1.0]],
      dumpName: 'exposure_cut',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 26, g: 26, b: 26, a: 255 }, 4);
  });

  it('warmth tint pushes red over blue when tint_amount > 0', async () => {
    // amount=0, tint_warmth=+1, tint_amount=1 → r * 1.5, b * 0.5
    // input grey 0.5 → R=192, G=128, B=64
    const frame = await runGpuEffectTest({
      module: 'exposure.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[0, 0.0], [1, 1.0], [2, 1.0]],
      dumpName: 'exposure_warm',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 192, g: 128, b: 64 }, 6);
  });

  it('tint_amount=0 cancels the tint regardless of warmth', async () => {
    // Warmth setting shouldn't matter when tint_amount = 0.
    const frame = await runGpuEffectTest({
      module: 'exposure.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[0, 0.0], [1, 1.0], [2, 0.0]],
      dumpName: 'exposure_no_tint',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 4);
  });
});
