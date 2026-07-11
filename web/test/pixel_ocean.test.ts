/**
 * E2E tests for source.pixel.ocean (nano bundle) — pixel-art ocean generator.
 *
 * The effect is a stateless-per-pixel hash field driven by two CPU step
 * accumulators, so frames are deterministic for a given (params, seed, ticks):
 * that's what the determinism / frozen-clock cases pin down. Coverage numbers
 * are loose — sprite pixels are a small fraction of the sea by design.
 *
 * Needs the dev server up (GPU_TEST_BASE_URL) and a fresh nano bundle
 * (native/wasm_modules/nano/build.sh).
 */
import { runGpuEffectTest } from './gpu-test-helpers';

jest.setTimeout(60000);

// Default ocean color 0.10/0.32/0.55 in bytes.
const OCEAN = { r: 26, g: 82, b: 140 };

describe('Pixel Ocean', () => {
  it('renders pure ocean color at density 0', async () => {
    const f = await runGpuEffectTest({
      module: 'source.pixel.ocean', bundle: 'nano',
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1],
      params: [['density', 0.0], ['composite', 0]],
      ticks: 8,
    });
    expect(f.success).toBe(true);
    expect(f.gpuErrors).toEqual([]);
    f.expectUniformColor(OCEAN, 4);
  });

  it('draws sparse black waves at full density', async () => {
    const f = await runGpuEffectTest({
      module: 'source.pixel.ocean', bundle: 'nano',
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1],
      params: [
        ['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6],
        ['backwards', 0.0],
      ],
      ticks: 8,
    });
    expect(f.success).toBe(true);
    // Some black wave pixels, but the sea stays mostly ocean-colored.
    f.expectCoverage((c) => c.r < 30 && c.g < 30 && c.b < 30, { min: 0.003, max: 0.5 });
    f.expectCoverage(
      (c) => Math.abs(c.r - OCEAN.r) < 8 && Math.abs(c.g - OCEAN.g) < 8 && Math.abs(c.b - OCEAN.b) < 8,
      { min: 0.5 });
  });

  it('is deterministic for a fixed seed, and the seed re-deals the sea', async () => {
    const cfg = {
      module: 'source.pixel.ocean' as const, bundle: 'nano' as const,
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1] as [number, number, number, number],
      params: [
        ['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6],
        ['seed', 0.25],
      ] as [string, number][],
      ticks: 8,
    };
    const a = await runGpuEffectTest(cfg);
    const b = await runGpuEffectTest(cfg);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.diffCount(b, 2)).toBe(0);

    const c = await runGpuEffectTest({
      ...cfg,
      params: [['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6], ['seed', 0.9]],
    });
    c.expectDifferentFrom(a, 10);
  });

  it('rotation turns the pattern', async () => {
    const base = {
      module: 'source.pixel.ocean' as const, bundle: 'nano' as const,
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1] as [number, number, number, number],
      ticks: 8,
    };
    const flat = await runGpuEffectTest({
      ...base, params: [['density', 1.0], ['pixel_size', 0.6], ['rotation', 0.0]],
    });
    const tilted = await runGpuEffectTest({
      ...base, params: [['density', 1.0], ['pixel_size', 0.6], ['rotation', 0.5]],
    });
    expect(flat.success).toBe(true);
    expect(tilted.success).toBe(true);
    tilted.expectDifferentFrom(flat, 10);
  });

  it('honours the wave color', async () => {
    const f = await runGpuEffectTest({
      module: 'source.pixel.ocean', bundle: 'nano',
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1],
      params: [
        ['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6],
        ['wave_color', [1.0, 0.0, 0.0]],
      ],
      ticks: 8,
    });
    expect(f.success).toBe(true);
    f.expectCoverage((c) => c.r > 200 && c.g < 60 && c.b < 60, { min: 0.002 });
  });

  it('composite Input passes the input through under the waves', async () => {
    const f = await runGpuEffectTest({
      module: 'source.pixel.ocean', bundle: 'nano',
      width: 96, height: 96,
      inputColor: [0.2, 0.4, 0.8, 1.0],
      params: [['composite', 3], ['density', 0.0]],
      ticks: 8,
    });
    expect(f.success).toBe(true);
    f.expectUniformColor({ r: 51, g: 102, b: 204 }, 4);
  });

  it('composite Transparent leaves the sea clear', async () => {
    const f = await runGpuEffectTest({
      module: 'source.pixel.ocean', bundle: 'nano',
      width: 96, height: 96,
      inputColor: [1, 1, 1, 1],
      params: [['composite', 1], ['density', 0.0]],
      ticks: 8,
    });
    expect(f.success).toBe(true);
    f.expectUniformColor({ a: 0 }, 2);
  });

  it('freezes when both step clocks are at rate 0', async () => {
    const base = {
      module: 'source.pixel.ocean' as const, bundle: 'nano' as const,
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1] as [number, number, number, number],
      params: [
        ['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6],
        ['anim_rate', 0.0], ['drift_rate', 0.0], ['forward_rate', 0.0],
      ] as [string, number][],
    };
    const short = await runGpuEffectTest({ ...base, ticks: 2 });
    const long = await runGpuEffectTest({ ...base, ticks: 30 });
    expect(short.success).toBe(true);
    expect(long.success).toBe(true);
    expect(short.diffCount(long, 2)).toBe(0);
  });

  it('forward (Y) drift carries the waves over time', async () => {
    // Only the forward clock runs (anim + sideways drift frozen), so any change
    // between an early and a late frame is the Y-axis march.
    const base = {
      module: 'source.pixel.ocean' as const, bundle: 'nano' as const,
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1] as [number, number, number, number],
      params: [
        ['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6],
        ['anim_rate', 0.0], ['drift_rate', 0.0], ['forward_rate', 1.0],
        ['forward_jitter', 0.0], ['backwards', 0.0],
      ] as [string, number][],
    };
    const early = await runGpuEffectTest({ ...base, ticks: 2 });
    const late = await runGpuEffectTest({ ...base, ticks: 60 });
    expect(early.success).toBe(true);
    expect(late.success).toBe(true);
    late.expectDifferentFrom(early, 10);
  });

  it('animates when the clocks run', async () => {
    const base = {
      module: 'source.pixel.ocean' as const, bundle: 'nano' as const,
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1] as [number, number, number, number],
      params: [
        ['density', 1.0], ['rotation', 0.0], ['pixel_size', 0.6],
        ['anim_rate', 1.0], ['drift_rate', 1.0],
      ] as [string, number][],
    };
    const early = await runGpuEffectTest({ ...base, ticks: 2 });
    const late = await runGpuEffectTest({ ...base, ticks: 60 });
    expect(early.success).toBe(true);
    expect(late.success).toBe(true);
    late.expectDifferentFrom(early, 10);
  });

  it('debug cell overlay draws the lattice', async () => {
    const base = {
      module: 'source.pixel.ocean' as const, bundle: 'nano' as const,
      width: 96, height: 96,
      inputColor: [0, 0, 0, 1] as [number, number, number, number],
      ticks: 4,
    };
    const off = await runGpuEffectTest({
      ...base, params: [['density', 0.5], ['rotation', 0.0], ['pixel_size', 0.6]],
    });
    const on = await runGpuEffectTest({
      ...base,
      params: [['density', 0.5], ['rotation', 0.0], ['pixel_size', 0.6], ['debug_cells', 1]],
    });
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    on.expectDifferentFrom(off, 10);
  });
});
