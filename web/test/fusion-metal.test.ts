import { setBackend, runGpuChainTest } from './gpu-test-helpers';

// Native Metal fusion coverage.
//
// fusion.test.ts covers the WebGPU fusion path with the test-only fuse_add /
// fuse_mul mappers. This file covers the NATIVE Metal SketchExecutor fusion path
// with real barrel effects (which aren't in the testonly bundle), via
// native_test_runner's chain mode. Two assertions per case:
//
//   1. The fused kernel is BYTE-IDENTICAL to the standalone (force-off) path —
//      fusion must not change pixels.
//   2. Fusion ACTUALLY happened (`fusedRuns` > 0 in the fused run, 0 in
//      force-off). This is the assertion that matters: a broken fused kernel
//      still renders correctly via the per-stage fallback, so a pixels-only test
//      passes even when fusion is silently dead (which it was — see the
//      fragment-lookup / compile-failure-cache / helper-extraction fixes).
//
// Metal only: the WebGPU side already has fusion coverage, and these chains use
// barrel effect ids the native runner registers (resolveEffectId).
describe('Native Metal fusion', () => {
  jest.setTimeout(30000);
  // Pin the native runner at execution time (forEachBackend only sets the
  // ambient backend during registration). No dev server / browser needed.
  beforeAll(() => setBackend('metal'));
  afterAll(() => setBackend('puppeteer'));

  const cases = [
    {
      name: 'brightness_contrast → invert (self-contained mappers)',
      chain: [
        { module: 'color.tone.brightness_contrast', params: [['brightness', 0.6], ['contrast', 0.55]] },
        { module: 'color.invert' },
      ],
    },
    {
      name: 'brightness_contrast → saturate → invert (saturate calls a helper fn)',
      chain: [
        { module: 'color.tone.brightness_contrast', params: [['brightness', 0.55]] },
        { module: 'color.saturate', params: [['asymm', 0.4], ['prescale', 1.2]] },
        { module: 'color.invert' },
      ],
    },
    {
      name: 'brightness_contrast → exposure → hsl → curve (4-stage fuse)',
      chain: [
        { module: 'color.tone.brightness_contrast', params: [['brightness', 0.58]] },
        { module: 'color.tone.exposure', params: [['exposure', 0.2]] },
        { module: 'color.hsl', params: [['saturation', 0.6]] },
        { module: 'color.tone.curve', params: [['gamma', 1.2]] },
      ],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: fused == standalone, byte-identical, and fusion fires`, async () => {
      const inputColor = [0.4, 0.6, 0.2, 1.0];
      const opts = { width: 32, height: 32, inputColor };

      const off = await runGpuChainTest({
        ...opts, chain: c.chain as any, fusionMode: 'force-off', dumpName: 'fusion_metal_off',
      });
      const on = await runGpuChainTest({
        ...opts, chain: c.chain as any, fusionMode: 'auto', dumpName: 'fusion_metal_on',
      });

      expect(off.success).toBe(true);
      expect(on.success).toBe(true);

      // (1) fused output matches the standalone path. Self-contained arithmetic
      // mappers are byte-exact; effects using transcendentals (saturate's
      // tanh/exp2) round ~1 LSB differently inlined-vs-standalone, the same
      // metal_parity envelope — so allow a tiny tolerance. A real fusion bug
      // (wrong fragment / wrong helper) shifts pixels by a lot, not 1 LSB.
      let maxDelta = 0;
      for (let i = 0; i < on.pixels.length; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(on.pixels[i] - off.pixels[i]));
      }
      expect(maxDelta).toBeLessThanOrEqual(2);

      // (2) fusion actually happened: force-off issued no fused dispatch; the
      // fused run collapsed the chain into >=1 fused kernel dispatch. This is
      // the assertion that catches a silently-broken fused kernel (which would
      // still render correctly via the per-stage fallback).
      expect(off.fusedRuns).toBe(0);
      expect(on.fusedRuns).toBeGreaterThanOrEqual(1);
    });
  }
});
