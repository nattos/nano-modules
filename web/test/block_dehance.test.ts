import { runGpuEffectTest, Frame } from './gpu-test-helpers';

// Per-effect tests for fx.block_dehance — a GPU rect pool that "dehances"
// the input (black / mosaic / noise) inside bright-seeking rectangles.
//
// The pool is GPU-resident and cycles over time, so these use
// renderEachTick + a small respawn_delay so the rects are alive by the
// snapshot. A solid input means bright-seek lands rects anywhere (uniform
// mask) — fine for asserting coverage/mode, not specific positions.

describe('Block Dehance Effect E2E', () => {
  jest.setTimeout(60000);

  const W = 128, H = 128;
  const luma = (p: { r: number; g: number; b: number }) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

  // Fill the pool fast: long life, tiny respawn delay, many rects.
  const base = (extra: [string, number][]): [string, number][] => [
    ['count', 60], ['pool_max', 64], ['life_s', 5.0], ['respawn_delay_s', 0.05],
    ['rect_width', 0.18], ['rect_height', 0.12], ['mask_temperature', 1.0], ['seed', 7],
    ...extra,
  ];

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'block_dehance.wasm', bundle: 'lights',
      inputColor: [0, 0, 0, 1], dumpName: 'block_dehance_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('fx.block_dehance');
  });

  it('count 0 is a pure passthrough', async () => {
    const frame = await runGpuEffectTest({
      module: 'block_dehance.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0.5, 0.5, 0.5, 1], renderEachTick: true,
      ticks: 5, params: [['count', 0], ['mode_black_weight', 1]],
      dumpName: 'block_dehance_passthrough',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 128, b: 128 }, 4);
  });

  it('black mode punches dark rectangles into the input', async () => {
    const frame = await runGpuEffectTest({
      module: 'block_dehance.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0.5, 0.5, 0.5, 1], renderEachTick: true,
      ticks: 20,
      params: base([['mode_black_weight', 1], ['mode_mosaic_weight', 0], ['mode_noise_weight', 0]]),
      dumpName: 'block_dehance_black',
    });
    expect(frame.success).toBe(true);
    // Lots of near-black coverage (the grey background is luma 128).
    frame.expectCoverage(c => luma(c) < 30, { min: 0.05 });
    // But not the whole frame — the background grey still shows.
    frame.expectCoverage(c => Math.abs(luma(c) - 128) < 10, { min: 0.1 });
  });

  it('noise mode replaces covered pixels with varied colour', async () => {
    const frame = await runGpuEffectTest({
      module: 'block_dehance.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0.5, 0.5, 0.5, 1], renderEachTick: true,
      ticks: 20,
      params: base([['mode_black_weight', 0], ['mode_mosaic_weight', 0], ['mode_noise_weight', 1],
                    ['noise_intensity', 1.0]]),
      dumpName: 'block_dehance_noise',
    });
    expect(frame.success).toBe(true);
    // Noise scatters pixels far from the flat grey in BOTH directions.
    frame.expectCoverage(c => luma(c) > 180, { min: 0.03 });
    frame.expectCoverage(c => luma(c) < 70, { min: 0.03 });
  });
});
