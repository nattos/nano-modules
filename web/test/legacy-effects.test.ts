import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect E2E for the `legacy` bundle (com.nano.legacy) — ports of shipped
// NanoGraph effects. Point at a running dev server via GPU_TEST_BASE_URL.

describe('Bicolor Gradient (color.legacy.bicolor_grad) E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and its parameters', async () => {
    const frame = await runGpuEffectTest({
      module: 'bicolor_grad.wasm',
      bundle: 'legacy',
      inputColor: [0.6, 0.2, 0.1, 1.0],
      dumpName: 'bicolor_grad_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.legacy.bicolor_grad');
    // `neutral` is a vec3/colour field, so it lives in the schema, not the
    // scalar params[] list — assert on the scalar knobs.
    const names = frame.params.map(p => p.name);
    expect(names).toContain('scale');
    expect(names).toContain('blend');
    expect(names).toContain('smoothing');
    expect(names).toContain('mode');
  });

  it('blend=0 is a passthrough (output equals input)', async () => {
    const frame = await runGpuEffectTest({
      module: 'bicolor_grad.wasm',
      bundle: 'legacy',
      width: 64, height: 64,
      inputColor: [0.6, 0.2, 0.1, 1.0],
      params: [['blend', 0.0], ['mode', 0]],
      samplePoints: [[32, 32]],
      dumpName: 'bicolor_grad_passthrough',
    });
    expect(frame.success).toBe(true);
    const s = frame.samples[0];
    expect(Math.abs(s.r - 153)).toBeLessThan(12);
    expect(Math.abs(s.g - 51)).toBeLessThan(12);
    expect(Math.abs(s.b - 26)).toBeLessThan(12);
  });

  it('a chroma-free (grey) input collapses the gradient to the neutral colour', async () => {
    // Grey input → no dominant hue → major/minor confidence ~0 → both ends of
    // the gradient fall back to the neutral colour, so the whole frame paints
    // neutral at blend=1.
    const frame = await runGpuEffectTest({
      module: 'bicolor_grad.wasm',
      bundle: 'legacy',
      width: 64, height: 64,
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [['blend', 1.0], ['mode', 0], ['neutral', [0.2, 0.4, 0.8]]],
      samplePoints: [[10, 10], [54, 54]],
      dumpName: 'bicolor_grad_neutral',
    });
    expect(frame.success).toBe(true);
    for (const s of frame.samples) {
      expect(Math.abs(s.r - 51)).toBeLessThan(20);   // 0.2 * 255
      expect(Math.abs(s.g - 102)).toBeLessThan(20);  // 0.4 * 255
      expect(Math.abs(s.b - 204)).toBeLessThan(20);  // 0.8 * 255
    }
  });
});

describe('Glisten (filter.legacy.glisten) E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and its parameters', async () => {
    const frame = await runGpuEffectTest({
      module: 'glisten.wasm',
      bundle: 'legacy',
      inputColor: [0.3, 0.3, 0.3, 1.0],
      dumpName: 'glisten_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.legacy.glisten');
    const names = frame.params.map(p => p.name);
    expect(names).toContain('size');
    expect(names).toContain('blades');
    expect(names).toContain('levels');
    expect(names).toContain('intensity');
  });

  it('adds light near the anchor (top-left) and leaves the far corner untouched', async () => {
    // On a uniform input the brightest-spot search settles on the first cell
    // (top-left). The additive sparkle brightens around it; the opposite
    // corner stays at the input value.
    const frame = await runGpuEffectTest({
      module: 'glisten.wasm',
      bundle: 'legacy',
      width: 64, height: 64,
      inputColor: [0.3, 0.3, 0.3, 1.0],
      params: [['intensity', 1.5], ['size', 0.3], ['flicker', 0.0]],
      samplePoints: [[2, 2], [62, 62]],
      ticks: 2,
      renderEachTick: true,
      dumpName: 'glisten_anchor',
    });
    expect(frame.success).toBe(true);
    const near = frame.samples.find(s => s.x === 2)!;
    const far = frame.samples.find(s => s.x === 62)!;
    expect(near.r).toBeGreaterThan(far.r + 10);  // sparkle brightened the anchor
    expect(Math.abs(far.r - 77)).toBeLessThan(12); // far corner ~ input (0.3*255)
  });
});
