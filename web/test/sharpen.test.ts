import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

// Per-effect tests for `filter.sharpen` against `core`.

describe('Sharpen Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'sharpen.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'sharpen_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.sharpen');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['amount', 'radius']);
  });

  it('uniform input is unaffected by sharpen', async () => {
    // High-pass on uniform = 0 → output equals input.
    const frame = await runGpuEffectTest({
      module: 'sharpen.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.2, 1.0],
      params: [[0, 1.0]],
      dumpName: 'sharpen_uniform',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 51, a: 255 }, 4);
  });

  it('sharpening a blurred grid restores edge contrast', async () => {
    const blurred = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: [[0, 0.2], [1, 0.2]] },
        { module: 'blur.wasm', params: [[0, 1.0]] },
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'sharpen_chain_pre',
    });
    const sharpened = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: [[0, 0.2], [1, 0.2]] },
        { module: 'blur.wasm', params: [[0, 1.0]] },
        { module: 'sharpen.wasm', params: [[0, 1.0]] },
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'sharpen_chain_post',
    });
    expect(blurred.success && sharpened.success).toBe(true);

    const std = (frame: typeof blurred) => {
      const pixels = frame.region(0, 0, frame.width, frame.height);
      const lum = pixels.map(p => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
      const v = lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length;
      return Math.sqrt(v);
    };
    expect(std(sharpened)).toBeGreaterThan(std(blurred));
  });
});
