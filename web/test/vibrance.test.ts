import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.vibrance` against `core`.
// amount [-1, +1] biased toward unsaturated pixels.

describe('Vibrance Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'vibrance.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'vibrance_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.vibrance');
    expect(frame.params.length).toBe(1);
    expect(frame.params[0].name).toBe('amount');
  });

  it('amount=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'vibrance.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [[0, 0.0]],
      dumpName: 'vibrance_off',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
  });

  it('amount=-1 fully desaturates a saturated pixel', async () => {
    // Pure red → luminance ~0.299 → ~76 grey
    const frame = await runGpuEffectTest({
      module: 'vibrance.wasm',
      bundle: 'core',
      inputColor: [1.0, 0.0, 0.0, 1.0],
      params: [[0, -1.0]],
      dumpName: 'vibrance_desat',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 76, g: 76, b: 76 }, 6);
  });

  it('amount=+1 has no effect on a fully-saturated pixel (weight = 0)', async () => {
    // Pure red is already saturated; vibrance's bias means amount=+1 leaves it alone.
    const frame = await runGpuEffectTest({
      module: 'vibrance.wasm',
      bundle: 'core',
      inputColor: [1.0, 0.0, 0.0, 1.0],
      params: [[0, 1.0]],
      dumpName: 'vibrance_no_bias',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 4);
  });

  it('amount=+1 boosts a slightly-saturated pixel noticeably', async () => {
    // Input (0.5, 0.4, 0.4): low saturation → larger weight → more boost.
    // The result should have more pronounced separation between R and G/B.
    const before = await runGpuEffectTest({
      module: 'vibrance.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.4, 0.4, 1.0],
      params: [[0, 0.0]],
      dumpName: 'vibrance_low_sat_before',
    });
    const after = await runGpuEffectTest({
      module: 'vibrance.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.4, 0.4, 1.0],
      params: [[0, 1.0]],
      dumpName: 'vibrance_low_sat_after',
    });

    expect(before.success && after.success).toBe(true);
    const a = after.averageColor();
    const b = before.averageColor();
    // R should have grown; G and B should have shrunk (or moved toward grey/away from grey opposite direction).
    expect(a.r).toBeGreaterThan(b.r);
    expect(a.g).toBeLessThan(b.g);
    expect(a.b).toBeLessThan(b.b);
  });
});
