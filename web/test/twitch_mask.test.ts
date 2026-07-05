import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `filter.glitch.twitch_mask` against `core`. A roaming vignette
// glitch: each frame picks a random anchor + strength and suppresses an oval.
// Param indices (declaration order):
//   0 = amount, 1 = shape, 2 = radius, 3 = softness, 4 = position

describe('Twitch Mask Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'twitch_mask_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.glitch.twitch_mask');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['amount', 'position', 'radius', 'shape', 'softness']);
  });

  it('amount=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [[0, 0.0]],
      ticks: 3,
      dumpName: 'twitch_mask_off',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
  });

  it('active twitch darkens a region of the frame', async () => {
    // position=+1 spawns near the centre; shape=-1 blacks the inside of the
    // oval → an on-screen region is suppressed. ticks>0 so the anchor is drawn.
    const frame = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, 1.0], [1, -1.0], [4, 1.0]],
      ticks: 2,
      dumpName: 'twitch_mask_active',
    });
    expect(frame.success).toBe(true);
    // Some pixels should be notably darker than the white input.
    expect(frame.countPixels(c => c.r < 200)).toBeGreaterThan(0);
  });

  it('shape=0 is solid, not a dead zone', async () => {
    // The old mask faded to nothing at shape≈0. Now |shape|=0 lerps to a solid
    // (uniform) suppression, so a white frame darkens almost everywhere.
    const frame = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, 1.0], [1, 0.0]],   // amount=1, shape=0
      ticks: 2,
      dumpName: 'twitch_mask_solid',
    });
    expect(frame.success).toBe(true);
    // Solid suppression → the vast majority of pixels are darkened.
    expect(frame.countPixels(c => c.r < 200)).toBeGreaterThan(64 * 64 / 2);
  });

  it('linear regime (shape=0.5, radius=0.5) keeps the centre clear', async () => {
    // Regression: the linear gradient used to read dark at the centre. With
    // radius=0.5 the 0.5 crossing sits out on the far side, so the centre is
    // transparent and only one side darkens. position=-1 → a clear axis.
    const frame = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, 1.0], [1, 0.5], [2, 0.5], [4, -1.0]],  // amount, shape, radius, position
      ticks: 2,
      dumpName: 'twitch_mask_linear',
    });
    expect(frame.success).toBe(true);
    // Centre stays clear (independent of the random anchor / strength).
    frame.expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 10);
    // ...while one side darkens.
    expect(frame.countPixels(c => c.r < 230)).toBeGreaterThan(0);
  });

  it('the mask roams between frames', async () => {
    const a = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, 1.0], [1, -1.0], [4, 1.0]],
      ticks: 1,
      dumpName: 'twitch_mask_frame_a',
    });
    const b = await runGpuEffectTest({
      module: 'filter.glitch.twitch_mask',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, 1.0], [1, -1.0], [4, 1.0]],
      ticks: 6,
      dumpName: 'twitch_mask_frame_b',
    });
    expect(a.success && b.success).toBe(true);
    // Fresh instances share the seed, so different tick counts → different anchor.
    b.expectDifferentFrom(a, 20);
  });
});
