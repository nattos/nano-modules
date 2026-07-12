import { runGpuEffectTest, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for `color.alpha.remap` against `core`.
//
// The effect's curve math is a hand-port of tap_mod::applyTapMod into HLSL, and
// it reaches the two backends by different roads: SPIR-V -> MSL on native, and
// SPIR-V -> WGSL (naga) on web. A shader naga rejects doesn't fail loudly — the
// effect just quietly stops transforming — so running the same cases on BOTH
// backends is what makes a translation break visible.
//
// Input alpha is 0.25 (64) throughout: far enough from 0 / 0.5 / 1 that an
// inverted, squared or rescaled result can't be mistaken for a pass-through.
forEachBackend((backend) => {
  describe(`Alpha Remap Effect E2E (${backend})`, () => {
    jest.setTimeout(30000);

    const INPUT: [number, number, number, number] = [0.8, 0.4, 0.2, 0.25];
    const RGB = { r: 204, g: 102, b: 51 };   // 0.8/0.4/0.2 * 255, unchanged by every case

    it('declares metadata', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        dumpName: 'alpha_remap_metadata',
      });

      expect(frame.success).toBe(true);
      expect(frame.metadata?.id).toBe('color.alpha.remap');
    });

    it('the identity window passes alpha through', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        params: [['in_min', 0], ['in_max', 1], ['out_min', 0], ['out_max', 1],
                 ['curve_in', 0], ['curve_out', 0], ['scale', 1]],
        dumpName: 'alpha_remap_identity',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { ...RGB, a: 64 }, 4);
    });

    it('an inverted output window inverts coverage, leaving RGB alone', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        params: [['out_min', 1], ['out_max', 0]],
        dumpName: 'alpha_remap_invert',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { ...RGB, a: 191 }, 4);   // 1 - 0.25
    });

    it('a quad ease-in curve eats into the matte', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        params: [['curve_in', 1]],
        dumpName: 'alpha_remap_quad',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { ...RGB, a: 16 }, 4);    // 0.25^2 = 0.0625
    });

    it('narrowing the input window steepens the matte', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        params: [['in_max', 0.5]],
        dumpName: 'alpha_remap_window',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { ...RGB, a: 128 }, 4);   // 0.25 over [0,0.5] -> 0.5
    });

    it('scale is applied last, in remap space', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        params: [['scale', 2]],
        dumpName: 'alpha_remap_scale',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { ...RGB, a: 128 }, 4);   // 0.25 * 2
    });

    it('alpha below the input window clamps transparent, not wrapped', async () => {
      const frame = await runGpuEffectTest({
        module: 'color.alpha.remap',
        bundle: 'core',
        inputColor: INPUT,
        params: [['in_min', 0.5], ['in_max', 1], ['saturate', 1]],
        dumpName: 'alpha_remap_clamp',
      });

      expect(frame.success).toBe(true);
      frame.expectPixelAt(32, 32, { ...RGB, a: 0 }, 4);
    });
  });
});
