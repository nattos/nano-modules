import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `color.tone.levels` against `core`.
// Param indices: 0=in_low, 1=in_high, 2=gamma, 3=out_low, 4=out_high.

describe('Levels Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'levels_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.tone.levels');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['gamma', 'in_high', 'in_low', 'out_high', 'out_low']);
  });

  it('default settings pass through unchanged', async () => {
    // in_low=0, in_high=1, gamma=0, out_low=0, out_high=1 → identity
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      dumpName: 'levels_identity',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
  });

  it('in_low=0.5 clips below-mid to black', async () => {
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [0.3, 0.3, 0.3, 1.0],
      params: [[0, 0.5]],
      dumpName: 'levels_clip_low',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 4);
  });

  it('in_high=0.5 clips above-mid to white', async () => {
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [0.6, 0.6, 0.6, 1.0],
      params: [[1, 0.5]],
      dumpName: 'levels_clip_high',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 4);
  });

  it('gamma=+1 lifts mid-grey toward white (exp 1/8)', async () => {
    // pow(0.5, 1/8) ≈ 0.917 → 234
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[2, 1.0]],
      dumpName: 'levels_gamma_lift',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 234, g: 234, b: 234 }, 5);
  });

  it('gamma=-1 crushes mid-grey toward black (exp 8)', async () => {
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [[2, -1.0]],
      dumpName: 'levels_gamma_crush',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 1, g: 1, b: 1 }, 3);
  });

  it('out_low/out_high compress the output range', async () => {
    // Identity input mapping, but output 0..1 compressed to 0.25..0.75.
    // Input 0.5 → x=0.5 → out = 0.5 * 0.5 + 0.25 = 0.5 → 128 (no change for mid)
    // Input 1.0 → x=1.0 → out = 0.75 → 191
    const frame = await runGpuEffectTest({
      module: 'levels.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[3, 0.25], [4, 0.75]],
      dumpName: 'levels_output_compress',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 191, g: 191, b: 191 }, 4);
  });
});
