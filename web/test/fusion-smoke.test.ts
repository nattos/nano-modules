import {
  runGpuEffectTest,
  runGpuChainTest,
  setBackend,
  type Backend,
} from './gpu-test-helpers';

// Fusion smoke coverage for EVERY per-pixel-mapper effect, on BOTH backends.
//
// fusion.test.ts / fusion-metal.test.ts pin down a handful of curated chains
// for byte-parity. This file instead casts a wide net: for each effect that
// declares itself a fusion mapper, attach a `brightness_contrast` upstream and
// confirm the two actually fuse into one kernel that compiles and renders. It's
// the cheap insurance that a code-gen change (new helper, renamed uniform,
// shader-extraction tweak) didn't silently break fusion for SOME effect that
// no curated test happens to exercise — the failure mode that let the
// fragment-lookup / helper-extraction bugs survive undetected.
//
// What each case asserts (NOT byte-parity — see below):
//   1. The effect still declares PerPixelMapper fusion (`fusionKind === 1`).
//      A legitimate change to Freeform should surface here as an explicit
//      signal, not a confusing fusedRuns=0.
//   2. `[brightness_contrast → effect]` renders successfully with no GPU
//      errors, in both force-off (standalone baseline) and auto (fused).
//   3. Fusion ACTUALLY fired in the auto run (`fusedRuns >= 1`) and did NOT in
//      force-off (`fusedRuns === 0`). This is the assertion that catches a
//      silently-dead fused kernel: a broken kernel still renders correctly via
//      the per-stage fallback, so only the fusedRuns counter reveals it.
//
// Why NOT byte-parity here: the standalone path quantises the intermediate
// (brightness_contrast's output) to the 8-bit ping-pong texture before the
// effect reads it, while the fused path keeps it in full float precision. For
// band-quantising effects (posterize, levels) a sub-LSB intermediate
// difference can flip an entire output band, so fused != standalone by design.
// Byte-parity for the chains where it DOES hold stays the job of the curated
// fusion tests. Here we only certify "compiles + fuses + renders".
const PER_PIXEL_MAPPER = 1;

interface FusibleEffect {
  /** Registered effect id. Both runners accept it directly as `module`
   *  (web's resolveEffectId passes unknown ids through; native keys on it). */
  id: string;
  /** Non-identity params so the fused transform actually does something.
   *  Only names we're confident match the schema — fusion fires regardless. */
  params?: [string, number][];
}

// Every effect that registers state::FusionKind::PerPixelMapper in the `core`
// bundle (grep `FusionKind::PerPixelMapper` in native/wasm_modules/*/main.cpp).
const EFFECTS: FusibleEffect[] = [
  { id: 'composite.bake_alpha' },
  { id: 'color.tone.brightness_contrast', params: [['brightness', 0.4]] },
  { id: 'color.color_space' },
  { id: 'color.tone.curve',      params: [['gamma', 1.5]] },
  { id: 'color.tone.exposure',   params: [['exposure', 0.3]] },
  { id: 'color.hsl',        params: [['saturation', 0.5]] },
  { id: 'color.hue_basis' },
  { id: 'color.invert' },
  { id: 'color.tone.levels' },
  { id: 'color.posterize',  params: [['levels', 4]] },
  { id: 'color.saturate',   params: [['asymm', 0.3]] },
  { id: 'color.vibrance',   params: [['amount', 0.5]] },
  { id: 'filter.vignette' },
];

const BACKENDS: Backend[] = ['puppeteer', 'metal'];
const BUNDLE = 'core' as const;
const INPUT_COLOR: [number, number, number, number] = [0.4, 0.6, 0.2, 1.0];
const W = 32, H = 32;

for (const backend of BACKENDS) {
  describe(`Fusion smoke — every mapper fuses (${backend})`, () => {
    jest.setTimeout(60000);
    // Pin the backend at EXECUTION time. Setting it only at registration is a
    // no-op for async `it`s (see forEachBackend / setBackend in gpu-test-helpers).
    beforeAll(() => setBackend(backend));
    afterAll(() => setBackend('puppeteer'));

    for (const fx of EFFECTS) {
      it(`${fx.id}: declares fusion and fuses with brightness_contrast`, async () => {
        // (1) The effect still declares itself a per-pixel mapper. force-off so
        // the read is independent of whether fusion currently works.
        const meta = await runGpuEffectTest({
          module: fx.id, bundle: BUNDLE,
          width: W, height: H, inputColor: INPUT_COLOR,
          params: fx.params, fusionMode: 'force-off',
          dumpName: `fusesmoke_${fx.id}_meta`,
        });
        expect(meta.success).toBe(true);
        expect(meta.fusionKind).toBe(PER_PIXEL_MAPPER);

        // (2)+(3) brightness_contrast → effect, standalone vs fused.
        const chain = [
          { module: 'color.tone.brightness_contrast', params: [['brightness', 0.55], ['contrast', 0.5]] as [string, number][] },
          { module: fx.id, params: fx.params },
        ];
        const opts = { chain, bundle: BUNDLE, width: W, height: H, inputColor: INPUT_COLOR };

        const off = await runGpuChainTest({ ...opts, fusionMode: 'force-off', dumpName: `fusesmoke_${fx.id}_off` });
        const on = await runGpuChainTest({ ...opts, fusionMode: 'auto', dumpName: `fusesmoke_${fx.id}_on` });

        expect(off.success).toBe(true);
        expect(on.success).toBe(true);
        expect(on.gpuErrors).toEqual([]);

        // Fusion fired in auto, not in force-off. This is the regression guard:
        // a broken fused kernel still renders via the fallback, so fusedRuns is
        // the only thing that reveals fusion silently died for this effect.
        expect(off.fusedRuns).toBe(0);
        expect(on.fusedRuns).toBeGreaterThanOrEqual(1);
      });
    }
  });
}
