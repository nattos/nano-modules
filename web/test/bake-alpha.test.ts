import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.bake_alpha` against the shipping `core`
// bundle. The effect composites the input *over* a chosen background
// colour: out.rgb = src.rgb * src.a + bg.rgb * (1 - src.a) and
// out.a = src.a + bg.a * (1 - src.a). With opaque-black default the
// alpha is "removed" against black; arbitrary backgrounds let the
// caller bake against any colour. With bg.a = 0 the input's alpha is
// preserved (transparent-aware composite).

describe('Bake Alpha Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and a single color input', async () => {
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'bake_alpha_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.bake_alpha');
    // `color` is a vec4 (rgba) so it doesn't appear in the legacy
    // scalar params[] list.
    expect(frame.params.length).toBe(0);
  });

  it('opaque input over default black is unchanged', async () => {
    // src=(0.4, 0.6, 0.8, 1.0), bg defaults to (0, 0, 0, 1).
    // src.a=1 → result = src exactly.
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      dumpName: 'bake_alpha_opaque_passthrough',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 204, a: 255 }, 4);
  });

  it('half-alpha input over black yields half-luminance', async () => {
    // src=(1, 1, 1, 0.5) over bg=(0, 0, 0, 1).
    // rgb = 1*0.5 + 0*0.5 = 0.5 → 128. out.a = 0.5 + 1*0.5 = 1 → 255.
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 0.5],
      dumpName: 'bake_alpha_half_over_black',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128, a: 255 }, 4);
  });

  it('half-alpha input over opaque red bakes against red', async () => {
    // src=(0, 0, 1, 0.5) over bg=(1, 0, 0, 1).
    // rgb = (0,0,1)*0.5 + (1,0,0)*0.5 = (0.5, 0, 0.5). out.a = 0.5 + 0.5 = 1.
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [0.0, 0.0, 1.0, 0.5],
      params: [['color', [1.0, 0.0, 0.0, 1.0]]],
      dumpName: 'bake_alpha_blue_over_red',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 0, b: 128, a: 255 }, 4);
  });

  it('zero-alpha input becomes the background colour', async () => {
    // src=(*, *, *, 0) over bg=(0.4, 0.6, 0.2, 1) → exactly bg.
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 0.0],
      params: [['color', [0.4, 0.6, 0.2, 1.0]]],
      dumpName: 'bake_alpha_full_bg',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 51, a: 255 }, 4);
  });

  it('transparent background preserves input alpha', async () => {
    // src=(1, 0.5, 0, 0.5) over bg=(0, 0, 0, 0).
    // rgb = (1, 0.5, 0)*0.5 + (0,0,0)*0.5 = (0.5, 0.25, 0).
    // out.a = 0.5 + 0 = 0.5 → 128.
    const frame = await runGpuEffectTest({
      module: 'bake_alpha.wasm',
      bundle: 'core',
      inputColor: [1.0, 0.5, 0.0, 0.5],
      params: [['color', [0.0, 0.0, 0.0, 0.0]]],
      dumpName: 'bake_alpha_transparent_bg',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 64, b: 0, a: 128 }, 4);
  });
});
