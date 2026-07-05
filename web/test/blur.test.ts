import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

// Per-effect tests for `filter.blur.gaussian` against `core`. The blur is a two-pass
// separable Gaussian with a CPU-driven kernel: tap LOCATIONS depend only
// on `quality` (so smooth radius modulation doesn't shimmer), tap COUNT
// and weights are recomputed from sigma per-frame.
//
// Param indices: 0 = radius, 1 = quality.

describe('Blur Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'filter.blur.gaussian',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'blur_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.blur.gaussian');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['quality', 'radius']);
  });

  it('uniform input stays uniform across the (radius, quality) plane', async () => {
    const cases: [number, number][][] = [
      [[0, 0.0], [1, 1.0]],
      [[0, 1.0], [1, 1.0]],
      [[0, 1.0], [1, 0.1]],
    ];
    for (let i = 0; i < cases.length; i++) {
      const frame = await runGpuEffectTest({
        module: 'filter.blur.gaussian',
        bundle: 'core',
        inputColor: [0.4, 0.6, 0.2, 1.0],
        params: cases[i],
        dumpName: `blur_uniform_${i}`,
      });
      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 102, g: 153, b: 51, a: 255 }, 4);
    }
  });

  it('radius=0 passes through unchanged at any quality', async () => {
    const frame = await runGpuEffectTest({
      module: 'filter.blur.gaussian',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.2, 1.0],
      params: [[0, 0.0], [1, 0.5]],
      dumpName: 'blur_zero_radius',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 51, a: 255 }, 2);
  });

  it('high-radius blur softens a grid (variance drops)', async () => {
    const sharp = await runGpuChainTest({
      chain: [{ module: 'source.grid', params: [[0, 0.2], [1, 0.2]] }],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'blur_chain_sharp',
    });
    const blurred = await runGpuChainTest({
      chain: [
        { module: 'source.grid', params: [[0, 0.2], [1, 0.2]] },
        { module: 'filter.blur.gaussian', params: [[0, 1.0], [1, 1.0]] },
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'blur_chain_blurred',
    });
    expect(sharp.success && blurred.success).toBe(true);

    const std = (frame: typeof sharp) => {
      const pixels = frame.region(0, 0, frame.width, frame.height);
      const lum = pixels.map((p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
      const v = lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length;
      return Math.sqrt(v);
    };
    expect(std(blurred)).toBeLessThan(std(sharp));
  });

  it('smooth-modulation: a tiny radius bump produces a tiny output diff', async () => {
    // The whole point of the fixed-tap-locations design: nudging radius by
    // a small amount at a stable quality should produce only a small,
    // uniform pixel change — no jumpy "tap pop-in" should add visible
    // jitter across the frame.
    const grid = (extra: any[]) => runGpuChainTest({
      chain: [
        { module: 'source.grid', params: [[0, 0.2], [1, 0.2]] },
        ...extra,
      ],
      bundle: 'core',
      width: 64, height: 64,
    });
    const a = await grid([{ module: 'filter.blur.gaussian', params: [[0, 0.50], [1, 1.0]] }]);
    const b = await grid([{ module: 'filter.blur.gaussian', params: [[0, 0.51], [1, 1.0]] }]);
    expect(a.success && b.success).toBe(true);

    const ap = a.region(0, 0, a.width, a.height);
    const bp = b.region(0, 0, b.width, b.height);
    let sum = 0;
    let maxDiff = 0;
    for (let i = 0; i < ap.length; i++) {
      const dr = Math.abs(ap[i].r - bp[i].r);
      const dg = Math.abs(ap[i].g - bp[i].g);
      const db = Math.abs(ap[i].b - bp[i].b);
      sum += dr + dg + db;
      maxDiff = Math.max(maxDiff, dr, dg, db);
    }
    const meanAbsDiff = sum / (ap.length * 3);
    // A 0.01 nudge in radius at quality=1 should be near-imperceptible.
    expect(meanAbsDiff).toBeLessThan(4);
    expect(maxDiff).toBeLessThan(20);
  });
});
