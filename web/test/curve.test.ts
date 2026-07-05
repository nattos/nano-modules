import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.tone.curve` against `core`. The slider is signed
// [-1, +1] mapping to power exponents 8 → 1 → 1/8.
//
// Param indices (schema declaration order): 0 = rgb, 1 = alpha.

describe('Curve Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.tone.curve',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'curve_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.tone.curve');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['alpha', 'rgb']);
  });

  it('rgb=0 / alpha=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.tone.curve',
      bundle: 'core',
      inputColor: [0.5, 0.25, 0.75, 0.6],
      params: [[0, 0.0], [1, 0.0]],
      dumpName: 'curve_identity',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 64, b: 191, a: 153 }, 4);
  });

  it('rgb=+1 lifts mid-grey toward white (exp 1/8)', async () => {
    // pow(0.5, 1/8) ≈ 0.917 → 234
    const frame = await runGpuEffectTest({
      module: 'color.tone.curve',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[0, 1.0]],
      dumpName: 'curve_lift',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 234, g: 234, b: 234 }, 5);
  });

  it('rgb=-1 crushes mid-grey toward black (exp 8)', async () => {
    // pow(0.5, 8) ≈ 0.0039 → 1
    const frame = await runGpuEffectTest({
      module: 'color.tone.curve',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[0, -1.0]],
      dumpName: 'curve_crush',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 1, g: 1, b: 1 }, 3);
  });

  it('alpha curve shapes alpha independently of RGB', async () => {
    // alpha=+1 lifts mid alpha (0.5 → ~0.917 → 234), RGB stays at default 0.
    const frame = await runGpuEffectTest({
      module: 'color.tone.curve',
      bundle: 'core',
      inputColor: [0.0, 0.0, 0.0, 0.5],
      params: [[0, 0.0], [1, 1.0]],
      dumpName: 'curve_alpha_lift',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 234 }, 5);
  });
});
