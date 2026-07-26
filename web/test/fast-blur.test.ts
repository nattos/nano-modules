import { runGpuChainTest, runGpuEffectTest, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for `filter.blur.fast` (the dual-filter / 13-tap +
// 9-tap blur). Compared to the precise Gaussian in `filter.blur.gaussian`, this
// trades exactness for speed — the assertions verify the blur
// behaviour rather than pixel-stable shape.

forEachBackend((backend) => {
describe(`Fast Blur Effect E2E (${backend})`, () => {
  jest.setTimeout(30000);

  it('declares metadata and a single iterations input', async () => {
    const frame = await runGpuEffectTest({
      module: 'filter.blur.fast',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'fast_blur_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.blur.fast');
    const names = frame.params.map(p => p.name);
    expect(names).toContain('iterations');
  });

  it('uniform input survives the blur (passthrough average)', async () => {
    // A constant-coloured field should remain that colour after any
    // number of blur iterations — averaging a constant gives the
    // constant. This catches gross errors in pass routing or
    // upsample/downsample weighting.
    const frame = await runGpuEffectTest({
      module: 'filter.blur.fast',
      bundle: 'core',
      width: 64, height: 64,
      inputColor: [0.4, 0.6, 0.2, 1.0],
      params: [['iterations', 4]],
      dumpName: 'fast_blur_constant',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 51 }, 6);
  });

  it('blurs a high-contrast pattern (grid → softened)', async () => {
    // Generate a fine grid, then blur. The blurred output should have
    // significantly fewer "bright line" pixels and significantly more
    // "midtone" pixels than the unblurred grid.
    const before = await runGpuChainTest({
      chain: [{ module: 'source.grid', params: [['cell_size', 0.1], ['line_width', 0.3]] }],
      bundle: 'core',
      width: 128, height: 128,
      dumpName: 'fast_blur_grid_before',
    });
    const after = await runGpuChainTest({
      chain: [
        { module: 'source.grid',      params: [['cell_size', 0.1], ['line_width', 0.3]] },
        { module: 'filter.blur.fast', params: [['iterations', 4]] },
      ],
      bundle: 'core',
      width: 128, height: 128,
      dumpName: 'fast_blur_grid_after',
    });
    expect(before.success && after.success).toBe(true);

    const isBrightLine = (c: any) => c.r > 220 && c.a > 220;
    const isMidtone    = (c: any) => c.r > 30 && c.r < 220;
    expect(after.countPixels(isBrightLine)).toBeLessThan(before.countPixels(isBrightLine));
    expect(after.countPixels(isMidtone)).toBeGreaterThan(before.countPixels(isMidtone));
  });

  it('more iterations → more uniform output (lower variance)', async () => {
    // The grid input has bright lines on a transparent background.
    // After blurring, the spread of red-channel values across the
    // frame collapses toward a single average. More iterations →
    // tighter spread.
    const variance = (frame: any) => {
      let sum = 0, sum2 = 0, n = 0;
      frame.forEachPixel((c: any) => { sum += c.r; sum2 += c.r * c.r; n++; });
      const mean = sum / n;
      return sum2 / n - mean * mean;
    };
    const fewer = await runGpuChainTest({
      chain: [
        { module: 'source.grid',      params: [['cell_size', 0.1], ['line_width', 0.3]] },
        { module: 'filter.blur.fast', params: [['iterations', 1]] },
      ],
      bundle: 'core',
      width: 128, height: 128,
      dumpName: 'fast_blur_iter1',
    });
    const more = await runGpuChainTest({
      chain: [
        { module: 'source.grid',      params: [['cell_size', 0.1], ['line_width', 0.3]] },
        { module: 'filter.blur.fast', params: [['iterations', 5]] },
      ],
      bundle: 'core',
      width: 128, height: 128,
      dumpName: 'fast_blur_iter5',
    });
    expect(fewer.success && more.success).toBe(true);
    expect(variance(more)).toBeLessThan(variance(fewer));
  });

  it('iterations=1 still produces a noticeable blur', async () => {
    // Even at iterations=1 (one down + one up pass), an isolated
    // bright pixel should bleed into its neighbours via the bilinear
    // 13-tap downsample.
    const before = await runGpuChainTest({
      chain: [{ module: 'source.grid', params: [['cell_size', 0.1], ['line_width', 0.3]] }],
      bundle: 'core',
      width: 128, height: 128,
      dumpName: 'fast_blur_iter1_before',
    });
    const after = await runGpuChainTest({
      chain: [
        { module: 'source.grid',      params: [['cell_size', 0.1], ['line_width', 0.3]] },
        { module: 'filter.blur.fast', params: [['iterations', 1]] },
      ],
      bundle: 'core',
      width: 128, height: 128,
      dumpName: 'fast_blur_iter1_after',
    });
    expect(before.success && after.success).toBe(true);
    after.expectDifferentFrom(before, 200);
  });
});
});
