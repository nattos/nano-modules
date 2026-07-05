import {
  runGpuEffectTest, runGpuChainTest, forEachBackend, forEachFusionMode,
} from './gpu-test-helpers';

// Per-effect tests for `filter.local_contrast` against `core`.
//
// Local contrast is a large-radius unsharp mask: fx::FastBlur builds a wide
// low-pass, then a combine pass adds the difference back (luma-preserving with a
// midtone-protection knob, an RGB per-channel mode, and highlight-colour recovery
// that re-tints blown peaks with the surrounding hue).
//
// NORMAL-BUNDLE STYLE (no legacy `x.wasm` alias map): effects are referenced by
// their real `module_type` id and params by NAME. Both resolvers fall through
// unknown ids to themselves, and the native runner only accepts string param
// paths — so real ids + named params are the single syntax that runs on BOTH the
// web (WebGPU) and native (Metal) backends.
//
//   forEachBackend    — runs every case on web AND native (parity).
//   forEachFusionMode — runs each in standalone / forced-fusion / planner-default.
// local_contrast is Freeform (multi-pass, neighbour sampling), so it never fuses:
// output is identical across all fusion modes — the sweep verifies that invariance.

const LC = 'filter.local_contrast';

forEachBackend((backend) => forEachFusionMode((mode) => {
describe(`Local Contrast E2E (${backend}, ${mode})`, () => {
  jest.setTimeout(45000);

  // source.grid → [extra stages]. Named params (cell_size, line_width) give a
  // crisp structured field for the transform to act on.
  const grid = (extra: any[], dump?: string) => runGpuChainTest({
    chain: [
      { module: 'source.grid', params: [['cell_size', 0.2], ['line_width', 0.2]] },
      ...extra,
    ],
    bundle: 'core', width: 64, height: 64, dumpName: dump,
  });

  it('registers with the right id', async () => {
    const f = await runGpuEffectTest({
      module: LC, bundle: 'core', inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: `local_contrast_meta_${backend}_${mode}`,
    });
    expect(f.success).toBe(true);
    expect(f.metadata?.id).toBe('filter.local_contrast');
  });

  it('enhances a structured grid (output differs from the plain grid)', async () => {
    const plain = await grid([], 'local_contrast_plain');
    const enhanced = await grid(
      [{ module: LC, params: [['amount', 0.7], ['radius', 0.5]] }], 'local_contrast_enhanced');
    expect(plain.success && enhanced.success).toBe(true);
    enhanced.expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    enhanced.expectDifferentFrom(plain, 100);
  });

  it('amount=0 is a pass-through (≈ the plain grid)', async () => {
    const plain = await grid([]);
    const off = await grid([{ module: LC, params: [['amount', 0.0], ['radius', 0.5]] }]);
    expect(plain.success && off.success).toBe(true);
    off.expectSameAs(plain, 2);
  });

  it('radius changes the scale of enhancement', async () => {
    // FBM noise (algorithm=2) has multi-scale detail, so a tight and a wide
    // low-pass diverge — a single-scale grid would wash to the same average.
    const noise = (radius: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'source.noise', params: [['algorithm', 2], ['scale', 0.6]] },
        { module: LC, params: [['amount', 0.7], ['radius', radius]] },
      ],
      bundle: 'core', width: 96, height: 96, dumpName: dump,
    });
    const tight = await noise(0.0, 'local_contrast_radius_tight');
    const wide  = await noise(1.0, 'local_contrast_radius_wide');
    expect(tight.success && wide.success).toBe(true);
    wide.expectDifferentFrom(tight, 100);
  });

  it('protect biases the boost toward the midtones', async () => {
    // A grayscale gradient spans the full tonal range, so midtone protection
    // (keyed off luminance) visibly reshapes which tones get boosted.
    const grad = (protect: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'source.gradient', params: [['softness', 1.0]] },
        { module: LC, params: [['amount', 0.9], ['radius', 0.5], ['protect', protect]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const none = await grad(0.0, 'local_contrast_protect_off');
    const full = await grad(1.0, 'local_contrast_protect_on');
    expect(none.success && full.success).toBe(true);
    full.expectDifferentFrom(none, 50);
  });

  it('color mode: Luma-preserving differs from per-channel RGB on colour', async () => {
    // Luma and RGB modes coincide on grayscale, so drive a COLOURED gradient
    // (saturated warm → cool) where the two paths genuinely diverge.
    const grad = (m: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'source.gradient', params: [
          ['softness', 1.0], ['color_a', [1.0, 0.2, 0.1]], ['color_b', [0.1, 0.2, 1.0]],
        ] },
        { module: LC, params: [['amount', 0.9], ['radius', 0.5], ['mode', m]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const luma = await grad(0, 'local_contrast_mode_luma');
    const rgb  = await grad(1, 'local_contrast_mode_rgb');
    expect(luma.success && rgb.success).toBe(true);
    rgb.expectDifferentFrom(luma, 50);
  });

  it('highlight recovery re-tints blown peaks (independent of contrast amount)', async () => {
    // Saturated-red → white gradient: the white end is bright + desaturated and
    // its low-pass carries the red halo. recover pushes that hue back in. Driven
    // at amount=0 so this isolates recovery from the contrast boost.
    const grad = (recover: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'source.gradient', params: [
          ['softness', 1.0], ['color_a', [1.0, 0.15, 0.1]], ['color_b', [1.0, 1.0, 1.0]],
        ] },
        { module: LC, params: [['amount', 0.0], ['recover', recover]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const off = await grad(0.0, 'local_contrast_recover_off');
    const on  = await grad(1.0, 'local_contrast_recover_on');
    expect(off.success && on.success).toBe(true);
    on.expectDifferentFrom(off, 50);
  });

  it('roll-off squashes the recovered chroma non-linearly (juicier peaks)', async () => {
    // Same red→white gradient as recovery, full recover, but sweep the roll-off
    // exponent: 0 is a plain linear tint, 1 rolls the off-channels off harder.
    // The two diverge only in the recovered region, so a difference proves the
    // non-linear squash actually reshapes the recovered colour.
    const grad = (rolloff: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'source.gradient', params: [
          ['softness', 1.0], ['color_a', [1.0, 0.15, 0.1]], ['color_b', [1.0, 1.0, 1.0]],
        ] },
        { module: LC, params: [['amount', 0.0], ['recover', 1.0], ['rolloff', rolloff]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const linear = await grad(0.0, 'local_contrast_rolloff_linear');
    const juicy  = await grad(1.0, 'local_contrast_rolloff_juicy');
    expect(linear.success && juicy.success).toBe(true);
    juicy.expectDifferentFrom(linear, 25);
  });
});
}));

// Schema (param list) check — puppeteer only: the native single-effect runner
// reports metadata.id but not the param list.
describe('Local Contrast schema', () => {
  jest.setTimeout(30000);
  it('declares amount, mode, protect, radius, recover, rolloff', async () => {
    const f = await runGpuEffectTest({
      module: LC, bundle: 'core', inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'local_contrast_params',
    });
    expect(f.success).toBe(true);
    expect(f.params.map((p) => p.name).sort())
      .toEqual(['amount', 'mode', 'protect', 'radius', 'recover', 'rolloff']);
  });
});
