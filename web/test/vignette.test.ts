import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `filter.vignette` against `core`. Tests use a 64x64
// input so the centre pixel is well inside the inner radius and the
// corners are outside, which makes assertions straightforward.
//
// Schema: amount, radius, softness (primary scalars); center (vec2),
// shape + squash (secondary). center is a vec2 so tests refer to it by name.

describe('Vignette Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'vignette.wasm',
      bundle: 'core',
      inputColor: [0.6, 0.6, 0.6, 1.0],
      dumpName: 'vignette_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.vignette');
    const names = frame.params.map(p => p.name).sort();
    // `center` is a vec2 so it doesn't appear in the legacy scalar
    // params[] list — only scalars do.
    expect(names).toEqual(['amount', 'radius', 'shape', 'softness', 'squash']);
  });

  it('amount=0 leaves the image unchanged everywhere', async () => {
    const frame = await runGpuEffectTest({
      module: 'vignette.wasm',
      bundle: 'core',
      inputColor: [0.6, 0.6, 0.6, 1.0],
      params: [[0, 0.0]],
      samplePoints: [[32, 32], [0, 0], [63, 63]],
      dumpName: 'vignette_off',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 153, g: 153, b: 153 }, 4);
  });

  it('amount=-1 darkens corners while leaving the centre intact', async () => {
    // Default radius=0.6, softness=0.4. On a square viewport, the centre
    // pixel (sq=0) is inside radius. The corners (|sq|≈√2) are well past
    // radius+softness=1.0, so the gain there approaches 0 → black.
    const frame = await runGpuEffectTest({
      module: 'vignette.wasm',
      bundle: 'core',
      width: 64, height: 64,
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, -1.0], [1, 0.6], [2, 0.4]],
      samplePoints: [[32, 32], [0, 0], [63, 63]],
      dumpName: 'vignette_dark_corners',
    });

    expect(frame.success).toBe(true);
    // Centre stays bright.
    frame.expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 6);
    // A corner pixel should be much darker than the centre — the vignette
    // doesn't have to crush all the way to 0 here because exact pixel
    // coordinates fall partway through the soft edge, but it must be
    // visibly less than the centre.
    const corner = frame.samples.find(s => s.x === 0 && s.y === 0);
    expect(corner).toBeDefined();
    expect(corner!.r).toBeLessThan(140);
  });

  it('amount=+1 brightens corners (saturates white)', async () => {
    const frame = await runGpuEffectTest({
      module: 'vignette.wasm',
      bundle: 'core',
      width: 64, height: 64,
      inputColor: [0.4, 0.4, 0.4, 1.0],
      params: [[0, 1.0], [1, 0.6], [2, 0.4]],
      samplePoints: [[32, 32], [0, 0]],
      dumpName: 'vignette_bright_corners',
    });

    expect(frame.success).toBe(true);
    // Centre stays at the input level.
    frame.expectPixelAt(32, 32, { r: 102, g: 102, b: 102 }, 6);
    const corner = frame.samples.find(s => s.x === 0 && s.y === 0);
    expect(corner!.r).toBeGreaterThan(140);
  });

  it('center offset relocates the bright spot', async () => {
    // Push the centre to (-1, 0) — the left edge in cover-square units.
    // The left-side pixels should now be the unaffected ones.
    const frame = await runGpuEffectTest({
      module: 'vignette.wasm',
      bundle: 'core',
      width: 64, height: 64,
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [[0, -1.0], [1, 0.6], [2, 0.4], ['center', [-1.0, 0.0]]],
      samplePoints: [[0, 32], [63, 32]],
      dumpName: 'vignette_offset',
    });

    expect(frame.success).toBe(true);
    const left = frame.samples.find(s => s.x === 0 && s.y === 32);
    const right = frame.samples.find(s => s.x === 63 && s.y === 32);
    expect(left!.r).toBeGreaterThan(right!.r);
  });
});
