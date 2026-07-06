import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for filter.blur.lens — "Lens" (nano bundle).
 *
 * A full photographic-lens sim: shaped-aperture bokeh gather + flare stack +
 * filmic finish. Multi-pass compute, linear-HDR, TimeIndependent. Exercised by
 * chaining a deterministic generator (source.grid, from core) → lens and
 * comparing param settings; we trace the effect's own INPUT ('in',
 * chain_entry side:'input') and the final output ('out') in one render.
 *
 * STAGE 1: only registration + the passthrough skeleton are asserted. The
 * per-pass behavioural cases land as the real passes are implemented.
 */
describe('Lens (filter.blur.lens) E2E', () => {
  jest.setTimeout(60000);

  const W = 128, H = 128;
  const MODULES = ['com.nano.testonly', 'com.nano.core', 'com.nano.nano'];
  const LENS = 'filter.blur.lens';

  const runChain = (id: string, params: Record<string, number | number[]>, dump: string,
                    gridParams: Record<string, number> = {}, waitFrames = 8) => {
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        { type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: gridParams },
        { type: 'module', module_type: LENS, instance_key: 'lens@0', params },
      ],
    };
    return runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'in',  target: { type: 'chain_entry', sketchId: id, colIdx: 0, chainIdx: 1, side: 'input' } },
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames, captureTraceIds: ['in', 'out'], dumpName: dump,
    });
  };

  it('registers with the right id and declares the param surface', async () => {
    const r = await runChain('lens_reg', {}, 'lens_reg');
    expect(r.success).toBe(true);
    const p = r.state.plugins.find((x: any) => x.id === LENS);
    expect(p).toBeTruthy();
    expect(p.io.find((io: any) => io.name === 'tex_in')).toBeTruthy();
    expect(p.io.find((io: any) => io.name === 'tex_out')).toBeTruthy();
    // Scalar/int/select fields surface in the flat params array.
    const names = p.params.map((x: any) => x.name);
    for (const n of ['preset', 'blur_amount', 'blades', 'cats_eye', 'coating',
                     'sun_intensity', 'halation', 'distortion', 'tca', 'exposure',
                     'tone', 'grain', 'quality', 'debug_view']) {
      expect(names).toContain(n);
    }
    // vec2/vec3(color) fields surface in the schema (the inspector binds via it).
    const sch = typeof p.schema === 'string' ? JSON.parse(p.schema) : p.schema;
    expect(sch.focus_center?.type).toBe('float2');
    expect(sch.sun_color?.type).toBe('float3');
    expect(sch.sun_color?.hint).toBe('color');
    expect(sch.halation_color?.type).toBe('float3');
    expect(p.capabilities).toContain('time_independent');
  });

  // STAGE 1: render is a straight passthrough copy, so out ≈ in regardless of
  // params. (Replaced by real behavioural checks as passes land.)
  it('skeleton renders a passthrough copy of its input', async () => {
    const r = await runChain('lens_pass', { blur_amount: 0.5, grain: 1.0 },
                             'lens_passthrough', { cell_size: 0.22, line_width: 0.12 });
    expect(r.success).toBe(true);
    const diff = r.trace('out').diffCount(r.trace('in'), 6);
    expect(diff).toBeLessThan(W * H * 0.02);
  });
});
