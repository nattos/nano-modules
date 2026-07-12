import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.colorize` against `core`.
// Schema: color (rgb — referenced by name), amount [0,1], mode select
// (0 = Luma, 1 = Multiply, 2 = Screen).

describe('Colorize Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.colorize',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'colorize_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.colorize');
    // `color` is an rgb field, so it doesn't appear in the scalar params[] list.
    expect(frame.params.map(p => p.name).sort()).toEqual(['amount', 'mode']);
  });

  it('amount=0 passes through unchanged in every mode', async () => {
    for (const mode of [0, 1, 2]) {
      const frame = await runGpuEffectTest({
        module: 'color.colorize',
        bundle: 'core',
        inputColor: [0.4, 0.6, 0.8, 1.0],
        params: [['amount', 0.0], ['mode', mode], ['color', [1.0, 0.0, 0.0]]],
        dumpName: `colorize_off_mode${mode}`,
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
    }
  });

  it('Luma: a white tint is plain greyscale', async () => {
    // Rec.709 luma of (0.4, 0.6, 0.8) = 0.2126*.4 + 0.7152*.6 + 0.0722*.8
    //                                  ≈ 0.5716 → ~146.
    const frame = await runGpuEffectTest({
      module: 'color.colorize',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['amount', 1.0], ['mode', 0], ['color', [1.0, 1.0, 1.0]]],
      dumpName: 'colorize_luma_grey',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 146, g: 146, b: 146 }, 4);
  });

  it('Luma: a red tint keeps the brightness but drops G and B', async () => {
    // Same luma (~0.5716) times (1, 0, 0) → (146, 0, 0).
    const frame = await runGpuEffectTest({
      module: 'color.colorize',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['amount', 1.0], ['mode', 0], ['color', [1.0, 0.0, 0.0]]],
      dumpName: 'colorize_luma_red',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 146, g: 0, b: 0 }, 4);
  });

  it('Multiply: the tint gels the image (a half-green tint halves G, kills R and B)', async () => {
    // (0.4, 0.6, 0.8) * (0, 0.5, 0) → (0, 0.3, 0) → (0, 76, 0).
    const frame = await runGpuEffectTest({
      module: 'color.colorize',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['amount', 1.0], ['mode', 1], ['color', [0.0, 0.5, 0.0]]],
      dumpName: 'colorize_multiply',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 0, g: 76, b: 0 }, 4);
  });

  it('Screen: the tint only lifts — never darkens', async () => {
    // 1 - (1-c)(1-t) with t = (0.5, 0, 0):
    //   R: 1 - 0.6*0.5 = 0.7 → 178;  G: 0.6 → 153;  B: 0.8 → 204 (unchanged).
    const frame = await runGpuEffectTest({
      module: 'color.colorize',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['amount', 1.0], ['mode', 2], ['color', [0.5, 0.0, 0.0]]],
      dumpName: 'colorize_screen',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 178, g: 153, b: 204 }, 4);
  });

  it('amount cross-fades between the original and the tint', async () => {
    // Halfway between (0.4, 0.6, 0.8) and its red-luma tint (0.5716, 0, 0).
    const frame = await runGpuEffectTest({
      module: 'color.colorize',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['amount', 0.5], ['mode', 0], ['color', [1.0, 0.0, 0.0]]],
      dumpName: 'colorize_halfway',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 124, g: 76, b: 102 }, 4);
  });
});
