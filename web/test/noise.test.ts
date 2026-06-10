import { runGpuTest } from './gpu-test-helpers';

describe('Noise Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      dumpName: 'noise_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('generator.noise');
  });

  it('white noise (algo=0) produces high-variance output', async () => {
    const frame = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 64, height: 64,
      params: [[0, 0], [1, 0.5], [2, 0.0], [3, 0.0]],  // algo=0, scale=0.5, contrast=0, seed=0
      dumpName: 'noise_white',
    });
    expect(frame.success).toBe(true);
    const pixels = frame.region(0, 0, 64, 64);
    const lum = pixels.map(p => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b);
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const variance = lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length;
    expect(Math.sqrt(variance)).toBeGreaterThan(40);  // standard dev > 40 (out of 255)
  });

  it('value noise (algo=1) is greyscale by default', async () => {
    const frame = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.0]],
      dumpName: 'noise_value',
    });
    expect(frame.success).toBe(true);
    // Greyscale → R == G == B for every pixel (within 2 LSB rounding).
    const pixels = frame.region(0, 0, 32, 32);
    let allGrey = true;
    for (const p of pixels) {
      if (Math.abs(p.r - p.g) > 2 || Math.abs(p.g - p.b) > 2) { allGrey = false; break; }
    }
    expect(allGrey).toBe(true);
  });

  it('color=1 produces independent RGB channels', async () => {
    const frame = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 0], [1, 0.5], [2, 0.0], [3, 0.0], [4, 4], [5, 1.0]],
      dumpName: 'noise_color',
    });
    expect(frame.success).toBe(true);
    // Pick a pixel; R, G, B should differ from each other in many cases.
    const pixels = frame.region(0, 0, 32, 32);
    let differingPixels = 0;
    for (const p of pixels) {
      if (Math.abs(p.r - p.g) > 5 || Math.abs(p.g - p.b) > 5) differingPixels++;
    }
    expect(differingPixels).toBeGreaterThan(pixels.length / 4);
  });

  it('value noise (algo=1) animates when speed > 0', async () => {
    // Previously only "static" moved; smooth modes now evolve through time.
    // param 6 = speed. Render at frame 0 vs after 30 ticks (0.48s of motion).
    const t0 = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.0], [6, 1.0]],
      ticks: 0,
      dumpName: 'noise_motion_t0',
    });
    const t30 = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.0], [6, 1.0]],
      ticks: 30,
      dumpName: 'noise_motion_t30',
    });
    expect(t0.success && t30.success).toBe(true);
    t30.expectDifferentFrom(t0, 50);
  });

  it('speed = 0 freezes all modes', async () => {
    // value noise, speed=0 → identical regardless of how many ticks elapse.
    const t0 = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.0], [6, 0.0]],
      ticks: 0,
      dumpName: 'noise_frozen_t0',
    });
    const t30 = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.0], [6, 0.0]],
      ticks: 30,
      dumpName: 'noise_frozen_t30',
    });
    expect(t0.success && t30.success).toBe(true);
    // No motion → frames identical (within LSB-rounding tolerance).
    t30.expectSameAs(t0, 2);
  });

  it('seed change produces a different pattern', async () => {
    const a = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 0], [1, 0.5], [2, 0.0], [3, 0.1]],
      dumpName: 'noise_seed_a',
    });
    const b = await runGpuTest({
      module: 'noise.wasm',
      bundle: 'core',
      width: 32, height: 32,
      params: [[0, 0], [1, 0.5], [2, 0.0], [3, 0.7]],
      dumpName: 'noise_seed_b',
    });
    expect(a.success && b.success).toBe(true);
    a.expectDifferentFrom(b, 50);
  });
});
