import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.tone.exposure` against `core`. amount [-1, +1]
// maps to ±3 stops (gain 1/8 .. 8). Warm/cool tinting moved to the
// dedicated `color.temperature` effect.
//
// Param indices (declaration order):
//   0 = amount

describe('Exposure Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.tone.exposure',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'exposure_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.tone.exposure');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['amount']);
  });

  it('amount=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.tone.exposure',
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
      module: 'color.tone.exposure',
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
      module: 'color.tone.exposure',
      bundle: 'core',
      inputColor: [0.8, 0.8, 0.8, 1.0],
      params: [[0, -1.0]],
      dumpName: 'exposure_cut',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 26, g: 26, b: 26, a: 255 }, 4);
  });
});
