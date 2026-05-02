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
      params: [[0, 0.0], [1, 0.5], [2, 0.5]],
      dumpName: 'grid_fine',
    });
    const coarse = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [[0, 1.0], [1, 0.5], [2, 0.5]],
      dumpName: 'grid_coarse',
    });
    expect(fine.success && coarse.success).toBe(true);
    // Fine grid has more line pixels than coarse grid.
    const linePixels = (frame: typeof fine) =>
      frame.countPixels(c => c.r > 150 && c.a > 100);
    expect(linePixels(fine)).toBeGreaterThan(linePixels(coarse));
  });

  it('custom line and bg colours apply', async () => {
    // line=red opaque, bg=blue opaque.
    const frame = await runGpuTest({
      module: 'grid.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [
        [0, 0.5], [1, 0.5], [2, 0.5],         // cell_size, line_width, softness
        [3, 0.0], [4, 0.0],                   // offset
        [5, 1.0], [6, 0.0], [7, 0.0], [8, 1.0], // line = red
        [9, 0.0], [10, 0.0], [11, 1.0], [12, 1.0], // bg = blue
      ],
      dumpName: 'grid_colors',
    });
    expect(frame.success).toBe(true);
    // Both red and blue pixels should appear.
    expect(frame.countPixels(c => c.r > 200 && c.b < 60)).toBeGreaterThan(0);
    expect(frame.countPixels(c => c.b > 200 && c.r < 60)).toBeGreaterThan(0);
  });
});
