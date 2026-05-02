import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.bake_alpha` against the shipping `core` bundle.
// `amount` mixes input → premultiplied (rgb * a). At amount=0 nothing
// changes; at amount=1 the result is fully premultiplied.

describe('Bake Alpha Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'bake_alpha_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.bake_alpha');
    expect(frame.params.length).toBe(1);
    expect(frame.params[0].name).toBe('amount');
  });

  it('amount=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [0.8, 0.4, 0.2, 0.5],
      params: [[0, 0.0]],
      dumpName: 'bake_alpha_passthrough',
    });

    expect(frame.success).toBe(true);
    // Input (204, 102, 51, 128) — should be exactly preserved.
    frame.expectPixelAt(32, 32, { r: 204, g: 102, b: 51, a: 128 }, 4);
  });

  it('amount=1 fully premultiplies RGB by alpha', async () => {
    // Input (1.0, 0.5, 0.0, 0.5) → premultiplied (0.5, 0.25, 0.0, 0.5)
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [1.0, 0.5, 0.0, 0.5],
      params: [[0, 1.0]],
      dumpName: 'bake_alpha_full',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 64, b: 0, a: 128 }, 4);
  });

  it('amount=0.5 produces a half-premultiplied mix', async () => {
    // Input (1.0, 1.0, 1.0, 0.5) → mid mix between (1,1,1) and (0.5,0.5,0.5) → 0.75
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 0.5],
      params: [[0, 0.5]],
      dumpName: 'bake_alpha_half',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 191, g: 191, b: 191, a: 128 }, 4);
  });

  it('alpha=1 input is unchanged regardless of amount', async () => {
    // Premultiplying by 1.0 is a no-op.
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [[0, 1.0]],
      dumpName: 'bake_alpha_opaque',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
  });
});
