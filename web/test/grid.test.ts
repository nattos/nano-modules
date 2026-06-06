import { runGpuTest } from './gpu-test-helpers';

describe('Grid Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      dumpName: 'grid_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('generator.grid');
  });

  it('default settings produce both line and background pixels', async () => {
    const frame = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      width: 96, height: 96,
      dumpName: 'grid_default',
    });
    expect(frame.success).toBe(true);
    // Default lines are white; default bg is transparent black.
    const onLine = frame.countPixels(c => c.r > 200 && c.a > 200);
    const offLine = frame.countPixels(c => c.r < 50 && c.a < 50);
    expect(onLine).toBeGreaterThan(0);
    expect(offLine).toBeGreaterThan(0);
  });

  it('cell_size=0 (clamped to 0.02) produces a fine grid', async () => {
    const fine = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      width: 64, height: 64,
      // Set fields by NAME — grid reads params via named patches (instance
      // ABI), so positional [index,val] entries (legacy params[] list) are
      // ignored and cell_size would stay at its default for both cases.
      // line_width is cell-NORMALIZED (pixel.hlsl), so total line coverage is
      // ~constant across cell_size; what changes is line POSITION/density.
      params: [['cell_size', 0.0], ['line_width', 0.5], ['softness', 0.1]],
      dumpName: 'grid_fine',
    });
    const coarse = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [['cell_size', 1.0], ['line_width', 0.5], ['softness', 0.1]],
      dumpName: 'grid_coarse',
    });
    expect(fine.success && coarse.success).toBe(true);
    // cell_size=0 clamps to a fine grid (~0.02); cell_size=1 is coarse. The
    // fine grid is non-degenerate (has both line and bg pixels), and because
    // its lines sit at a different spatial frequency than the coarse grid, the
    // two frames must differ pixel-wise (this is what proves cell_size took
    // effect through the clamp, not a total-line-pixel count which is
    // cell_size-invariant for this shader).
    const linePixels = (frame: typeof fine) =>
      frame.countPixels(c => c.r > 150 && c.a > 100);
    const bgPixels = (frame: typeof fine) =>
      frame.countPixels(c => c.a < 100);
    expect(linePixels(fine)).toBeGreaterThan(0);
    expect(bgPixels(fine)).toBeGreaterThan(0);
    fine.expectDifferentFrom(coarse, 50);
  });

  it('custom line and bg colours apply', async () => {
    // line=red opaque, bg=blue opaque.
    const frame = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [
        [0, 0.5], [1, 0.5], [2, 0.5],          // cell_size, line_width, softness
        ['offset', [0.0, 0.0]],
        ['line', [1.0, 0.0, 0.0, 1.0]],         // red
        ['bg',   [0.0, 0.0, 1.0, 1.0]],         // blue
      ],
      dumpName: 'grid_colors',
    });
    expect(frame.success).toBe(true);
    // Both red and blue pixels should appear.
    expect(frame.countPixels(c => c.r > 200 && c.b < 60)).toBeGreaterThan(0);
    expect(frame.countPixels(c => c.b > 200 && c.r < 60)).toBeGreaterThan(0);
  });
});
