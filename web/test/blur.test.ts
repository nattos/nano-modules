import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

// Per-effect tests for `video.blur` against `core`.

describe('Blur Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'blur.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'blur_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.blur');
    expect(frame.params.length).toBe(1);
    expect(frame.params[0].name).toBe('radius');
  });

  it('uniform input stays uniform regardless of radius', async () => {
    const frame = await runGpuEffectTest({
      module: 'blur.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.2, 1.0],
      params: [[0, 1.0]],
      dumpName: 'blur_uniform',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 51, a: 255 }, 4);
  });

  it('radius=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'blur.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.2, 1.0],
      params: [[0, 0.0]],
      dumpName: 'blur_zero',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 51, a: 255 }, 2);
  });

  it('blurring a grid reduces high-frequency variance', async () => {
    // Use the grid generator (also in core) as a high-frequency source.
    // Run grid alone, then grid → blur, and compare luminance variance.
    const sharp = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: [[0, 0.2], [1, 0.2]] },  // small cells, mid line width
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'blur_chain_sharp',
    });
    const blurred = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: [[0, 0.2], [1, 0.2]] },
        { module: 'blur.wasm', params: [[0, 1.0]] },
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'blur_chain_blurred',
    });
    expect(sharp.success && blurred.success).toBe(true);

    const std = (frame: typeof sharp) => {
      const pixels = frame.region(0, 0, frame.width, frame.height);
      const lum = pixels.map((p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
      const v = lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length;
      return Math.sqrt(v);
    };
    expect(std(blurred)).toBeLessThan(std(sharp));
  });
});
