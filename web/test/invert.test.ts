import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.invert` against `core`. Inversion is now
// unconditional (partial-strength mixing is handled by the system-level
// per-effect alpha). Param indices: 0 = invert_alpha (bool as 0/1).

describe('Invert Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.invert',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'invert_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.invert');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['invert_alpha']);
  });

  it('fully inverts RGB', async () => {
    // (0.2, 0.4, 0.6) → (0.8, 0.6, 0.4) → (204, 153, 102)
    const frame = await runGpuEffectTest({
      module: 'color.invert',
      bundle: 'core',
      inputColor: [0.2, 0.4, 0.6, 1.0],
      dumpName: 'invert_full',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 204, g: 153, b: 102, a: 255 }, 4);
  });

  it('alpha is preserved by default', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.invert',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.4],
      params: [[0, 0.0]],
      dumpName: 'invert_alpha_keep',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 102 }, 3);
  });

  it('invert_alpha=1 also flips the alpha channel', async () => {
    // alpha 0.4 inverted to 0.6 → 153
    const frame = await runGpuEffectTest({
      module: 'color.invert',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.4],
      params: [[0, 1.0]],
      dumpName: 'invert_alpha_flip',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { a: 153 }, 3);
  });
});
