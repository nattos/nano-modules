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

  const GRID = { cell_size: 0.22, line_width: 0.12 };

  it('renders a non-solid frame (the pipeline dispatches cleanly)', async () => {
    const r = await runChain('lens_render', {}, 'lens_render', GRID);
    expect(r.success).toBe(true);
    r.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
  });

  it('bokeh softens the image (blur amount changes the look)', async () => {
    const sharp = await runChain('lens_b0', { blur_amount: 0.0 }, 'lens_blur_0', GRID);
    const soft  = await runChain('lens_b1', { blur_amount: 0.6 }, 'lens_blur_1', GRID);
    expect(sharp.success).toBe(true);
    expect(soft.success).toBe(true);
    soft.trace('out').expectDifferentFrom(sharp.trace('out'), 100);
  });

  it('grain bites (deterministic film grain differs from clean)', async () => {
    const clean = await runChain('lens_g0', { blur_amount: 0.3, grain: 0.0 }, 'lens_grain_0', GRID);
    const noisy = await runChain('lens_g1', { blur_amount: 0.3, grain: 1.0 }, 'lens_grain_1', GRID);
    expect(clean.success).toBe(true);
    expect(noisy.success).toBe(true);
    noisy.trace('out').expectDifferentFrom(clean.trace('out'), 50);
  });

  it('exposure changes the output brightness', async () => {
    const dim    = await runChain('lens_e0', { exposure: -0.5 }, 'lens_exp_0', GRID);
    const bright = await runChain('lens_e1', { exposure: 0.5 },  'lens_exp_1', GRID);
    expect(dim.success).toBe(true);
    expect(bright.success).toBe(true);
    let sumDim = 0, sumBright = 0;
    dim.trace('out').forEachPixel((c) => { sumDim += c.r + c.g + c.b; });
    bright.trace('out').forEachPixel((c) => { sumBright += c.r + c.g + c.b; });
    expect(sumBright).toBeGreaterThan(sumDim);
  });
});
