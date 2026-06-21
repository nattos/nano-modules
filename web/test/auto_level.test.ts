import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

// Per-effect tests for `color.tone.auto_level` against `core`.
// Param indices (declaration order): 0 = equalize, 1 = median_target, 2 = median_pull.

const W = 64, H = 64;

// Value-noise input → a mid-concentrated luminance histogram to reshape.
function noiseAutoLevel(equalize: number, target: number, pull: number) {
  return runGpuChainTest({
    chain: [
      { module: 'noise.wasm', params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.2]] }, // value noise, fixed seed
      { module: 'auto_level.wasm', params: [[0, equalize], [1, target], [2, pull]] },
    ],
    bundle: 'core',
    width: W, height: H,
    dumpName: `auto_level_${equalize}_${target}_${pull}`,
  });
}

function lum(p: { r: number; g: number; b: number }) {
  return 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
}
function lumStdDev(frame: any) {
  const L = frame.region(0, 0, W, H).map(lum);
  const mean = L.reduce((a: number, b: number) => a + b, 0) / L.length;
  return Math.sqrt(L.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / L.length);
}
function lumMean(frame: any) {
  const L = frame.region(0, 0, W, H).map(lum);
  return L.reduce((a: number, b: number) => a + b, 0) / L.length;
}

describe('Auto Level Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'auto_level.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'auto_level_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.tone.auto_level');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['equalize', 'median_pull', 'median_target']);
  });

  it('flat (constant-luminance) input passes through untouched', async () => {
    // Even with equalize cranked: a flat histogram has nothing to reshape, so
    // the buildlut blank-flag makes apply a pure pass-through.
    const frame = await runGpuEffectTest({
      module: 'auto_level.wasm',
      bundle: 'core',
      inputColor: [0.3, 0.5, 0.7, 1.0],
      params: [[0, 1.0]],
      dumpName: 'auto_level_flat',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 77, g: 128, b: 179, a: 255 }, 4);
  });

  it('neutral params (equalize=0, median_pull=0) reproduce the input', async () => {
    const raw = await runGpuChainTest({
      chain: [{ module: 'noise.wasm', params: [[0, 1], [1, 0.5], [2, 0.0], [3, 0.2]] }],
      bundle: 'core', width: W, height: H, dumpName: 'auto_level_raw',
    });
    const neutral = await noiseAutoLevel(0.0, 0.5, 0.0);
    expect(raw.success && neutral.success).toBe(true);
    neutral.expectSameAs(raw, 2);
  });

  it('equalize widens the luminance distribution', async () => {
    const off = await noiseAutoLevel(0.0, 0.5, 0.0);
    const on  = await noiseAutoLevel(1.0, 0.5, 0.0);
    expect(off.success && on.success).toBe(true);
    expect(lumStdDev(on)).toBeGreaterThan(lumStdDev(off));
  });

  it('median pull shifts brightness toward the target', async () => {
    const dark   = await noiseAutoLevel(0.0, 0.1, 1.0);  // pull median down
    const bright = await noiseAutoLevel(0.0, 0.9, 1.0);  // pull median up
    expect(dark.success && bright.success).toBe(true);
    expect(lumMean(bright)).toBeGreaterThan(lumMean(dark) + 20);
  });
});
