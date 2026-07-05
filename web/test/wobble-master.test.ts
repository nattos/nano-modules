import { runGpuEffectTest } from './gpu-test-helpers';
import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for warp.legacy.wobble_master — "Wobble Master", the v2 port of the
 * Resolume Wire "Wobble Master 2" family (beat-pulsed radial-ripple wobble +
 * chromatic dispersion). Warping a solid is invisible, so the transform is
 * exercised via a source.grid chain; `amount` drives the ripple manually.
 */
describe('Wobble Master (warp.legacy.wobble_master) E2E', () => {
  jest.setTimeout(60000);

  const SOLID: [number, number, number, number] = [0.15, 0.30, 0.55, 1.0];

  it('declares metadata and its parameters', async () => {
    const frame = await runGpuEffectTest({
      module: 'warp.legacy.wobble_master', bundle: 'legacy',
      inputColor: SOLID,
      dumpName: 'wm_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('warp.legacy.wobble_master');
    const names = frame.params.map(p => p.name);
    for (const n of ['trigger', 'gate', 'amount', 'amplitude', 'frequency',
                     'wave_speed', 'chroma', 'hue', 'attack', 'release']) {
      expect(names).toContain(n);
    }
  });

  const runChain = (id: string, params: Record<string, number>, dump: string) => {
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        { type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: {} },
        { type: 'module', module_type: 'warp.legacy.wobble_master', instance_key: 'wm@0', params },
      ],
    };
    return runEngineTest({
      width: 128, height: 128,
      modules: ['com.nano.core', 'com.nano.legacy'],
      commands: [
        { type: 'createSketch', sketchId: id, sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames: 8,
      captureTraceIds: ['out'],
      dumpName: dump,
    });
  };

  const runGridOnly = (id: string, dump: string) => runEngineTest({
    width: 128, height: 128,
    modules: ['com.nano.core', 'com.nano.legacy'],
    commands: [
      { type: 'createSketch', sketchId: id, sketch: {
        anchor: null, wires: [],
        chain: [{ type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: {} }],
      }},
      { type: 'setTracePoints', tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: id } },
      ]},
    ],
    waitFrames: 8,
    captureTraceIds: ['out'],
    dumpName: dump,
  });

  it('the radial ripple warps the structured input', async () => {
    const still = await runChain('wm_still', { amount: 0.0 }, 'wm_still');
    const rippled = await runChain('wm_rip',
      { amount: 1.0, amplitude: 1.0, frequency: 0.6, chroma: 0.3, wave_speed: 0.0 }, 'wm_rippled');
    expect(still.success).toBe(true);
    expect(rippled.success).toBe(true);
    let lit = 0;
    still.trace('out').forEachPixel((c) => { if (c.r + c.g + c.b > 24) lit++; });
    expect(lit).toBeGreaterThan(100);
    rippled.trace('out').expectDifferentFrom(still.trace('out'), 100);
  });

  it('the chromatic dispersion alone changes the image', async () => {
    const none = await runChain('wm_cn', { amount: 1.0, amplitude: 1.0, frequency: 0.6, chroma: 0.0 }, 'wm_chroma_off');
    const split = await runChain('wm_cs', { amount: 1.0, amplitude: 1.0, frequency: 0.6, chroma: 1.0 }, 'wm_chroma_on');
    expect(none.success).toBe(true);
    expect(split.success).toBe(true);
    split.trace('out').expectDifferentFrom(none.trace('out'), 100);
  });

  it('is a passthrough at rest (amount=0)', async () => {
    const grid = await runGridOnly('wm_grid', 'wm_gridonly');
    const rest = await runChain('wm_rest', { amount: 0.0 }, 'wm_rest');
    expect(grid.success).toBe(true);
    expect(rest.success).toBe(true);
    rest.trace('out').expectSameAs(grid.trace('out'), 2);
  });
});
