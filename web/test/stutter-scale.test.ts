import { runGpuEffectTest } from './gpu-test-helpers';
import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for warp.legacy.stutter_scale — "Stutter Scale", the v2 port of the
 * Resolume Wire "Stutter Scale 2" patch (beat-stutter scale/flip/hue/invert
 * glitch). Exercised on a source.grid chain; `rate=0` + a fixed `sweep` pins
 * the stutter to one deterministic step.
 */
describe('Stutter Scale (warp.legacy.stutter_scale) E2E', () => {
  jest.setTimeout(60000);

  const SOLID: [number, number, number, number] = [0.15, 0.30, 0.55, 1.0];

  it('declares metadata and its parameters', async () => {
    const frame = await runGpuEffectTest({
      module: 'stutter_scale.wasm', bundle: 'legacy',
      inputColor: SOLID,
      dumpName: 'ss_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('warp.legacy.stutter_scale');
    const names = frame.params.map(p => p.name);
    for (const n of ['rate', 'sweep', 'levels', 'min_scale', 'max_scale', 'jitter',
                     'hue', 'boost', 'intensity', 'flip', 'color_invert', 'seed']) {
      expect(names).toContain(n);
    }
  });

  const runChain = (id: string, params: Record<string, number>, dump: string) => {
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        { type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: {} },
        { type: 'module', module_type: 'warp.legacy.stutter_scale', instance_key: 'ss@0', params },
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
      waitFrames: 6,
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
    waitFrames: 6,
    captureTraceIds: ['out'],
    dumpName: dump,
  });

  it('a stutter step transforms the structured input', async () => {
    const off = await runChain('ss_off', { intensity: 0.0 }, 'ss_off');
    const on = await runChain('ss_on',
      { intensity: 1.0, rate: 0.0, sweep: 0.5, min_scale: 2.0, max_scale: 8.0, jitter: 0.3 }, 'ss_on');
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    let lit = 0;
    off.trace('out').forEachPixel((c) => { if (c.r + c.g + c.b > 24) lit++; });
    expect(lit).toBeGreaterThan(100);
    on.trace('out').expectDifferentFrom(off.trace('out'), 100);
  });

  it('different sweep positions land on different stutter steps', async () => {
    const a = await runChain('ss_a',
      { intensity: 1.0, rate: 0.0, sweep: 0.15, min_scale: 2.0, max_scale: 8.0, jitter: 0.4 }, 'ss_step_a');
    const b = await runChain('ss_b',
      { intensity: 1.0, rate: 0.0, sweep: 0.85, min_scale: 2.0, max_scale: 8.0, jitter: 0.4 }, 'ss_step_b');
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    b.trace('out').expectDifferentFrom(a.trace('out'), 100);
  });

  it('is a passthrough at intensity=0 (is_identity)', async () => {
    const grid = await runGridOnly('ss_grid', 'ss_gridonly');
    const rest = await runChain('ss_rest', { intensity: 0.0 }, 'ss_rest');
    expect(grid.success).toBe(true);
    expect(rest.success).toBe(true);
    rest.trace('out').expectSameAs(grid.trace('out'), 2);
  });
});
