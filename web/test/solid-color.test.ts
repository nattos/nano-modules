import { runGpuTest } from './gpu-test-helpers';

// Per-effect tests for `generator.solid_color` against the shipping `core`
// bundle. solid_color is a generator (no texture input), three Standard
// params (red/green/blue). Param indices: 0=red, 1=green, 2=blue.

describe('Solid Color Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      dumpName: 'sc_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('generator.solid_color');
    expect(frame.params.length).toBe(3);
    expect(frame.params[0].name).toBe('red');
    expect(frame.params[1].name).toBe('green');
    expect(frame.params[2].name).toBe('blue');
  });

  it('default params produce mid-grey', async () => {
    // Defaults: r=g=b=0.5 → ~(128,128,128)
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      dumpName: 'sc_default_grey',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 128, b: 128, a: 255 }, 4);
  });

  it('renders pure red', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      params: [[0, 1.0], [1, 0.0], [2, 0.0]],
      dumpName: 'sc_red',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 0, b: 0, a: 255 }, 2);
  });

  it('renders pure green', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      params: [[0, 0.0], [1, 1.0], [2, 0.0]],
      dumpName: 'sc_green',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 255, b: 0, a: 255 }, 2);
  });

  it('renders pure blue', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      params: [[0, 0.0], [1, 0.0], [2, 1.0]],
      dumpName: 'sc_blue',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 255, a: 255 }, 2);
  });

  it('renders black at all-zero', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      params: [[0, 0.0], [1, 0.0], [2, 0.0]],
      dumpName: 'sc_black',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 2);
  });

  it('renders white at all-one', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      params: [[0, 1.0], [1, 1.0], [2, 1.0]],
      dumpName: 'sc_white',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 2);
  });

  it('mixes channels independently', async () => {
    // Yellow = R + G, no blue.
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      params: [[0, 1.0], [1, 1.0], [2, 0.0]],
      dumpName: 'sc_yellow',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 0, a: 255 }, 2);
  });

  it('output is uniform across the entire frame', async () => {
    const frame = await runGpuTest({
      module: 'solid_color.wasm',
      bundle: 'core',
      width: 96, height: 96,
      params: [[0, 0.3], [1, 0.6], [2, 0.9]],
      samplePoints: [[0, 0], [95, 0], [0, 95], [95, 95], [48, 48]],
      dumpName: 'sc_uniform',
    });

    expect(frame.success).toBe(true);
    // Every sample point should match within 2 LSBs (rounding).
    frame.expectUniformColor(
      { r: Math.round(0.3 * 255), g: Math.round(0.6 * 255), b: Math.round(0.9 * 255), a: 255 },
      2,
    );
  });
});
