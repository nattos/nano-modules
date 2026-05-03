import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.color_space` against `core`. The effect
// always routes input → linear (canonical) → output, so all four
// combinations of (in_space × out_space) are covered by a single
// shader path; the tests pin a few representative round-trips.

// Reference math (per the IEC sRGB spec):
//   srgb→linear:  c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4
//   linear→srgb:  c <= 0.0031308 ? 12.92*c : 1.055*c^(1/2.4) - 0.055
// At c = 0.5 (input r=128/255 ≈ 0.502): srgb→linear ≈ 0.2159 → 55.
// At c = 0.5 linear: linear→srgb ≈ 0.7354 → 187.

describe('Color Space Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and two select inputs', async () => {
    const frame = await runGpuEffectTest({
      module: 'color_space.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'color_space_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.color_space');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['in_space', 'out_space']);
  });

  it('default sRGB → Linear darkens a mid-grey', async () => {
    // 0.502 sRGB → ~0.2158 linear → ~55.
    const frame = await runGpuEffectTest({
      module: 'color_space.wasm',
      bundle: 'core',
      inputColor: [0.502, 0.502, 0.502, 1.0],
      dumpName: 'color_space_default_srgb_linear',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 55, g: 55, b: 55, a: 255 }, 3);
  });

  it('Linear → sRGB brightens a 0.5 mid-grey', async () => {
    // Treating input 0.502 as already-linear: encode to sRGB → ~0.7354 → 187.
    const frame = await runGpuEffectTest({
      module: 'color_space.wasm',
      bundle: 'core',
      inputColor: [0.502, 0.502, 0.502, 1.0],
      params: [['in_space', 1], ['out_space', 0]],
      dumpName: 'color_space_linear_srgb',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 187, g: 187, b: 187, a: 255 }, 3);
  });

  it('identity (sRGB → sRGB) is pass-through', async () => {
    const frame = await runGpuEffectTest({
      module: 'color_space.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['in_space', 0], ['out_space', 0]],
      dumpName: 'color_space_id_srgb',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('identity (Linear → Linear) is pass-through', async () => {
    const frame = await runGpuEffectTest({
      module: 'color_space.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['in_space', 1], ['out_space', 1]],
      dumpName: 'color_space_id_linear',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('endpoints are stable: 0 → 0, 1 → 1 (any direction)', async () => {
    for (const params of [
      [['in_space', 0], ['out_space', 1]],
      [['in_space', 1], ['out_space', 0]],
    ] as any) {
      const black = await runGpuEffectTest({
        module: 'color_space.wasm',
        bundle: 'core',
        inputColor: [0, 0, 0, 1],
        params,
        dumpName: 'color_space_black',
      });
      expect(black.success).toBe(true);
      black.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 2);

      const white = await runGpuEffectTest({
        module: 'color_space.wasm',
        bundle: 'core',
        inputColor: [1, 1, 1, 1],
        params,
        dumpName: 'color_space_white',
      });
      expect(white.success).toBe(true);
      white.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 2);
    }
  });
});
