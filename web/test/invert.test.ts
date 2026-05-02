import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.invert` against `core`.
// Param indices: 0 = amount, 1 = invert_alpha (bool as 0/1).

describe('Invert Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'invert.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'invert_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.invert');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['amount', 'invert_alpha']);
  });

  it('amount=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'invert.wasm',
      bundle: 'core',
      inputColor: [0.2, 0.4, 0.6, 0.8],
      params: [[0, 0.0]],
      dumpName: 'invert_off',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 51, g: 102, b: 153, a: 204 }, 4);
  });

  it('amount=1 fully inverts RGB', async () => {
    // (0.2, 0.4, 0.6) → (0.8, 0.6, 0.4) → (204, 153, 102)
    const frame = await runGpuEffectTest({
      module: 'invert.wasm',
      bundle: 'core',
      inputColor: [0.2, 0.4, 0.6, 1.0],
      params: [[0, 1.0]],
      dumpName: 'invert_full',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 204, g: 153, b: 102, a: 255 }, 4);
  });

  it('amount=0.5 is a half-inverted mix', async () => {
    // Input black: lerp(0, 1, 0.5) = 0.5 → 128
    const frame = await runGpuEffectTest({
      module: 'invert.wasm',
      bundle: 'core',
      inputColor: [0.0, 0.0, 0.0, 1.0],
      params: [[0, 0.5]],
      dumpName: 'invert_half',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128, a: 255 }, 4);
  });

  it('alpha is preserved by default even at full invert', async () => {
    const frame = await runGpuEffectTest({
      module: 'invert.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.4],
      params: [[0, 1.0], [1, 0.0]],
      dumpName: 'invert_alpha_keep',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 102 }, 3);
  });

  it('invert_alpha=1 also flips the alpha channel', async () => {
    // alpha 0.4 inverted to 0.6 → 153
    const frame = await runGpuEffectTest({
      module: 'invert.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.4],
      params: [[0, 1.0], [1, 1.0]],
      dumpName: 'invert_alpha_flip',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 153 }, 3);
  });
});
