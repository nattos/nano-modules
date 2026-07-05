import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

// Per-effect tests for `filter.local_contrast` against `core`. Local contrast is
// a large-radius unsharp mask: fx::FastBlur builds a wide low-pass, then a
// combine pass adds the difference back (luma-preserving by default, with a
// midtone-protection knob and an RGB per-channel mode).
//
// Scalar param indices (schema input-field order): 0 = amount, 1 = radius,
// 2 = protect, 3 = mode. A flat solid is invisible through it (no local detail),
// so the transform is exercised by chaining a structured source and diffing.

describe('Local Contrast Effect E2E', () => {
  jest.setTimeout(30000);

  // grid params (cell_size, line_width) that give a crisp structured field.
  const GRID: [number, number][] = [[0, 0.2], [1, 0.2]];

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'local_contrast.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'local_contrast_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.local_contrast');
    const names = frame.params.map((p) => p.name).sort();
    expect(names).toEqual(['amount', 'mode', 'protect', 'radius', 'recover']);
  });

  it('enhances a structured grid (output differs from the plain grid)', async () => {
    const plain = await runGpuChainTest({
      chain: [{ module: 'grid.wasm', params: GRID }],
      bundle: 'core', width: 64, height: 64,
      dumpName: 'local_contrast_plain',
    });
    const enhanced = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: GRID },
        { module: 'local_contrast.wasm', params: [[0, 0.7], [1, 0.5]] },
      ],
      bundle: 'core', width: 64, height: 64,
      dumpName: 'local_contrast_enhanced',
    });
    expect(plain.success && enhanced.success).toBe(true);
    enhanced.expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    enhanced.expectDifferentFrom(plain, 100);
  });

  it('amount=0 is a pass-through (≈ the plain grid)', async () => {
    const plain = await runGpuChainTest({
      chain: [{ module: 'grid.wasm', params: GRID }],
      bundle: 'core', width: 64, height: 64,
      dumpName: 'local_contrast_pt_plain',
    });
    const off = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: GRID },
        { module: 'local_contrast.wasm', params: [[0, 0.0], [1, 0.5]] },
      ],
      bundle: 'core', width: 64, height: 64,
      dumpName: 'local_contrast_pt_off',
    });
    expect(plain.success && off.success).toBe(true);
    off.expectSameAs(plain, 2);
  });

  it('radius changes the scale of enhancement', async () => {
    // FBM noise (algorithm=2) has multi-scale detail, so a tight low-pass and a
    // wide low-pass diverge — a single-scale grid would wash to the same average
    // at both radii. noise params: 0=algorithm, 1=scale.
    const noise = (radius: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'noise.wasm', params: [[0, 2], [1, 0.6]] },
        { module: 'local_contrast.wasm', params: [[0, 0.7], [1, radius]] },
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
    // (which keys off luminance) visibly reshapes which tones get boosted.
    const grad = (protect: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'gradient.wasm', params: [[2, 1.0]] },  // soft gradient
        { module: 'local_contrast.wasm', params: [[0, 0.9], [1, 0.5], [2, protect]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const none = await grad(0.0, 'local_contrast_protect_off');
    const full = await grad(1.0, 'local_contrast_protect_on');
    expect(none.success && full.success).toBe(true);
    full.expectDifferentFrom(none, 50);
  });

  it('color mode: Luma-preserving differs from per-channel RGB on colour', async () => {
    // Luma and RGB modes are identical on grayscale, so drive a COLOURED
    // gradient (saturated warm → cool) where the two paths genuinely diverge.
    const grad = (mode: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'gradient.wasm', params: [
          [2, 1.0],
          ['color_a', [1.0, 0.2, 0.1]],
          ['color_b', [0.1, 0.2, 1.0]],
        ] },
        { module: 'local_contrast.wasm', params: [[0, 0.9], [1, 0.5], [3, mode]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const luma = await grad(0, 'local_contrast_mode_luma');
    const rgb  = await grad(1, 'local_contrast_mode_rgb');
    expect(luma.success && rgb.success).toBe(true);
    rgb.expectDifferentFrom(luma, 50);
  });

  it('highlight recovery re-tints blown peaks (independent of contrast amount)', async () => {
    // A saturated-red → white gradient: the white end is bright + desaturated,
    // and the low-pass there carries the red halo. recover pushes that hue back
    // in. Driven at amount=0 so this isolates recovery from the contrast boost.
    // Params: 0=amount, 4=recover.
    const grad = (recover: number, dump: string) => runGpuChainTest({
      chain: [
        { module: 'gradient.wasm', params: [
          [2, 1.0],
          ['color_a', [1.0, 0.15, 0.1]],
          ['color_b', [1.0, 1.0, 1.0]],
        ] },
        { module: 'local_contrast.wasm', params: [[0, 0.0], [4, recover]] },
      ],
      bundle: 'core', width: 64, height: 64, dumpName: dump,
    });
    const off = await grad(0.0, 'local_contrast_recover_off');
    const on  = await grad(1.0, 'local_contrast_recover_on');
    expect(off.success && on.success).toBe(true);
    on.expectDifferentFrom(off, 50);
  });
});
