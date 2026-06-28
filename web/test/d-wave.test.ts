import { runGpuEffectTest } from './gpu-test-helpers';
import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for warp.legacy.d_wave — the "D wave" radial-ripple distortion field
 * ported from the shipped NanoGraph Darkburst (the one block used live).
 *
 * Warping a SOLID input is invisible (every displaced sample reads the same
 * colour), so the field itself is verified via the debug overlay, and the real
 * warp is verified by chaining a deterministic structured generator
 * (source.grid) → d_wave and comparing distortion 0 (passthrough) vs 1.
 */
describe('D Wave (warp.legacy.d_wave) E2E', () => {
  jest.setTimeout(60000);

  it('declares metadata and its parameters', async () => {
    const frame = await runGpuEffectTest({
      module: 'd_wave.wasm',
      bundle: 'legacy',
      inputColor: [0.2, 0.4, 0.6, 1.0],
      dumpName: 'd_wave_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('warp.legacy.d_wave');
    const names = frame.params.map(p => p.name);
    expect(names).toContain('distortion');
    expect(names).toContain('count');
    expect(names).toContain('wave_speed');
    expect(names).toContain('scale');
    expect(names).toContain('density');
    expect(names).toContain('spread');
    expect(names).toContain('grain');
  });

  it('builds a structured wave field from the particle pool (debug overlay)', async () => {
    // debug_field=1 paints the raw polar wave field (red) regardless of the
    // input, isolating the particle splat + polar lookup. The pool of elongated
    // blobs makes a structured (non-uniform) field — streaks with gaps between.
    const frame = await runGpuEffectTest({
      module: 'd_wave.wasm',
      bundle: 'legacy',
      width: 128, height: 128,
      inputColor: [0.0, 0.0, 0.0, 1.0],
      params: [
        ['distortion', 0.0],   // overlay only — no warp
        ['count', 400],
        ['density', 0.6],      // thin streaks
        ['wave_speed', 0.3],
        ['debug_field', 1.0],
      ],
      ticks: 10,
      renderEachTick: true,
      dumpName: 'd_wave_field',
    });
    expect(frame.success).toBe(true);

    let maxR = 0, lit = 0, dark = 0;
    frame.forEachPixel((c) => {
      if (c.r > maxR) maxR = c.r;
      if (c.r > 40) lit++;
      if (c.r < 8) dark++;
    });
    expect(maxR).toBeGreaterThan(60);    // waves present
    expect(lit).toBeGreaterThan(50);     // a real field, not a stray pixel
    expect(dark).toBeGreaterThan(50);    // gaps between streaks → structured
  });

  it('radially warps a structured input', async () => {
    // source.grid → d_wave. distortion=0 is a pure passthrough (warpFactor==1),
    // so run A is the clean grid (deterministic, static generator). Run B warps
    // it with strong ripples. The two must differ → the warp moved pixels.
    const buildChain = (overrides: Record<string, unknown>): Sketch => ({
      anchor: null,
      wires: [],
      chain: [
        { type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: {} },
        {
          type: 'module', module_type: 'warp.legacy.d_wave', instance_key: 'dw@0',
          params: { render_alpha: 1.0, ...overrides },
        },
      ],
    });

    const flat = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nano.core', 'com.nano.legacy'],
      commands: [
        { type: 'createSketch', sketchId: 'dw_flat', sketch: buildChain({ distortion: 0.0 }) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'dw_flat' } },
        ]},
      ],
      waitFrames: 16,
      captureTraceIds: ['out'],
      dumpName: 'd_wave_warp_flat',
    });
    expect(flat.success).toBe(true);

    const warped = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nano.core', 'com.nano.legacy'],
      commands: [
        { type: 'createSketch', sketchId: 'dw_warp',
          sketch: buildChain({ distortion: 1.0, count: 400, spread: 0.6, wave_speed: 0.4 }) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'dw_warp' } },
        ]},
      ],
      waitFrames: 16,
      captureTraceIds: ['out'],
      dumpName: 'd_wave_warp_on',
    });
    expect(warped.success).toBe(true);

    // The grid must actually have rendered (so "differ" is meaningful).
    let lit = 0;
    flat.trace('out').forEachPixel((c) => { if (c.r + c.g + c.b > 24) lit++; });
    expect(lit).toBeGreaterThan(100);

    // The ripples displaced the grid lines → the frames differ.
    warped.trace('out').expectDifferentFrom(flat.trace('out'), 100);
  });
});
