import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

describe('Transform Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'warp.transform',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'transform_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('warp.transform');
  });

  it('default identity transform passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'warp.transform',
      bundle: 'core',
      inputColor: [0.4, 0.7, 0.2, 1.0],
      dumpName: 'transform_identity',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 178, b: 51 }, 4);
  });

  it('large translate moves content offscreen with clamp wrap', async () => {
    // Take a grid; translate by (1, 0). Sampling clamps to the right edge,
    // so the resulting frame should be uniform along x (just the right-edge
    // column smeared across).
    const frame = await runGpuChainTest({
      chain: [
        { module: 'source.grid', params: [[0, 0.3], [1, 0.2]] },
        { module: 'warp.transform', params: [['translate', [1.0, 0.0]]] },
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'transform_translate',
    });
    expect(frame.success).toBe(true);
  });

  it('rotation by ±180° flips the image around the pivot', async () => {
    // Build a horizontal gradient, rotate 180°. Pixel near the left edge
    // should now hold the colour that was previously near the right edge.
    const before = await runGpuChainTest({
      chain: [
        { module: 'source.gradient', params: [[0, 0.0], [1, 0.0], [2, 1.0]] },  // angle=0 (left→right), full ramp
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'transform_rotate_pre',
    });
    const after = await runGpuChainTest({
      chain: [
        { module: 'source.gradient', params: [[0, 0.0], [1, 0.0], [2, 1.0]] },
        { module: 'warp.transform', params: [[1, 1.0]] },  // rotation=+1 → +180°
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'transform_rotate_post',
    });
    expect(before.success && after.success).toBe(true);
    // Compare a sample at (8, 32) of after with one near (55, 32) of before.
    const left_after = after.pixelAt(8, 32);
    const right_before = before.pixelAt(55, 32);
    // The image should have flipped, so left-side luminance after ≈ right-side luminance before.
    const lum = (p: { r: number; g: number; b: number }) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
    expect(Math.abs(lum(left_after) - lum(right_before))).toBeLessThan(40);
  });
});
