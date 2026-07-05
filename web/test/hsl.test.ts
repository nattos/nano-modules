import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.hsl` against `core`.
// Param indices: 0=hue_shift, 1=saturation, 2=lightness.

describe('HSL Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hsl',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'hsl_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.hsl');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['hue_shift', 'lightness', 'saturation']);
  });

  it('all-zero passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hsl',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      dumpName: 'hsl_identity',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
  });

  it('saturation=-1 collapses to greyscale', async () => {
    // Pure red → luminance ~0.5 → mid grey ~ (128, 128, 128)
    const frame = await runGpuEffectTest({
      module: 'color.hsl',
      bundle: 'core',
      inputColor: [1.0, 0.0, 0.0, 1.0],
      params: [[1, -1.0]],
      dumpName: 'hsl_desat',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 8);
  });

  it('hue_shift=+1 (180°) rotates red to cyan', async () => {
    // Red (1,0,0) → cyan (0,1,1)
    const frame = await runGpuEffectTest({
      module: 'color.hsl',
      bundle: 'core',
      inputColor: [1.0, 0.0, 0.0, 1.0],
      params: [[0, 1.0]],
      dumpName: 'hsl_hue_180',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 0, g: 255, b: 255 }, 6);
  });

  it('lightness=+1 lifts to white', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hsl',
      bundle: 'core',
      inputColor: [0.5, 0.0, 0.0, 1.0],
      params: [[2, 1.0]],
      dumpName: 'hsl_light_max',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255 }, 6);
  });

  it('lightness=-1 crushes to black', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hsl',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[2, -1.0]],
      dumpName: 'hsl_light_min',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0 }, 4);
  });
});
