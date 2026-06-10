import { runGpuEffectTest, Frame } from './gpu-test-helpers';

// Per-effect tests for gen.tingle_top — sparkles bundled at the top of each
// bar while gated, draining downward on release. The GPU particle pool cycles
// over time, so these use renderEachTick. With a black input the sparkles are
// just bright pixels, so the gated-at-top vs released-fills-down envelope is
// visible as where the bright coverage lands vertically.

describe('Tingle Top Effect E2E', () => {
  jest.setTimeout(60000);

  const W = 128, H = 128;
  const luma = (p: { r: number; g: number; b: number }) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

  // Fraction of bright pixels in the vertical band [y0, y1).
  const brightBand = (f: Frame, y0: number, y1: number): number => {
    let bright = 0, n = 0;
    for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
      for (let x = 0; x < W; x++) { if (luma(f.pixelAt(x, y)) > 40) bright++; n++; }
    }
    return n > 0 ? bright / n : 0;
  };

  const params = (extra: [string, number][]): [string, number][] => [
    ['density', 300], ['intensity', 2.0], ['size', 0.012], ['hue', 0.12],
    ['top_band_height', 0.1], ['particle_life_ms', 300], ['respawn_delay_ms', 10],
    ['frame_alpha_jitter', 0.0], ['seed', 5], ...extra,
  ];

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'tingle_top.wasm', bundle: 'lights',
      inputColor: [0, 0, 0, 1], dumpName: 'tingle_top_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('gen.tingle_top');
  });

  it('gated: sparkles stay bundled at the top band', async () => {
    // default_gate_state locks the region at top_band_height.
    const frame = await runGpuEffectTest({
      module: 'tingle_top.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 20, params: params([['default_gate_state', 1]]),
      dumpName: 'tingle_top_gated',
    });
    expect(frame.success).toBe(true);
    expect(brightBand(frame, 0.0, 0.2)).toBeGreaterThan(0.01);   // sparkles up top
    expect(brightBand(frame, 0.6, 1.0)).toBeLessThan(0.003);     // bottom stays dark
  });

  it('prewarm: velocity drifts particles down the bar on the very first frame', async () => {
    // Region LOCKED at the top 5% (gated), but downward velocity. The analytic
    // prewarm gives each particle a random age and drifts it by velocity×age,
    // so the bar is already populated top-to-bottom on frame 1 — impossible
    // without the velocity-based prewarm (fresh spawns would all be at the top).
    const run = (velY: number) => runGpuEffectTest({
      module: 'tingle_top.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 1,
      params: params([['default_gate_state', 1], ['top_band_height', 0.05],
                      ['particle_velocity_y', velY], ['particle_life_ms', 1500],
                      ['respawn_delay_ms', 0]]),
      dumpName: `tingle_top_prewarm_${velY}`,
    });
    const moving = await run(1.0);
    const still = await run(0.0);
    expect(moving.success && still.success).toBe(true);
    // Mid-bar is populated on frame 1 only with velocity (drift); without it,
    // everything is stuck in the top band.
    expect(brightBand(moving, 0.4, 0.6)).toBeGreaterThan(0.01);
    expect(brightBand(still, 0.4, 0.6)).toBeLessThan(0.002);
  });

  it('released: the spawn region drains down to fill the bar', async () => {
    // Released (default_gate_state false) → region ramps to 1.0, so sparkles
    // spawn across the full height (region starts settled at 1.0).
    const frame = await runGpuEffectTest({
      module: 'tingle_top.wasm', bundle: 'lights',
      width: W, height: H, inputColor: [0, 0, 0, 1], renderEachTick: true,
      ticks: 20, params: params([['default_gate_state', 0]]),
      dumpName: 'tingle_top_released',
    });
    expect(frame.success).toBe(true);
    // Now the lower band carries sparkles too.
    expect(brightBand(frame, 0.6, 1.0)).toBeGreaterThan(0.01);
  });
});
