import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for filter.reconstruct.line — "Line Reconstruct" (nano bundle).
 *
 * An SMAA-like morphological reconstructor: classify each pixel (line / point /
 * step-edge / junction / smooth-gradient) then re-render crisp uniform-width
 * strokes + de-band. Multi-pass compute; TimeIndependent; strength 0 = identity.
 *
 * A flat solid has no structure to reconstruct, so the transform is exercised by
 * chaining a deterministic structured generator (source.grid, from core) → line
 * reconstruct and comparing param settings. We trace the effect's own INPUT
 * ('in', chain_entry side:'input') and the final output ('out') in one render so
 * passthrough / identity can be checked against the exact input.
 */
describe('Line Reconstruct (filter.reconstruct.line) E2E', () => {
  jest.setTimeout(60000);

  const W = 128, H = 128;
  const MODULES = ['com.nano.testonly', 'com.nano.core', 'com.nano.nano'];
  const LR = 'filter.reconstruct.line';

  // source.grid → line_reconstruct. Traces the effect input ('in') and output.
  const runChain = (id: string, params: Record<string, number>, dump: string,
                    gridParams: Record<string, number> = {}, waitFrames = 8) => {
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        { type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: gridParams },
        { type: 'module', module_type: LR, instance_key: 'lr@0', params },
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
    const r = await runChain('lr_reg', { strength: 1.0 }, 'line_reconstruct_reg');
    expect(r.success).toBe(true);
    const lr = r.state.plugins.find((p: any) => p.id === LR);
    expect(lr).toBeTruthy();
    // I/O texture rails present (kind 0 = input, kind 1 = output).
    expect(lr.io.find((io: any) => io.name === 'tex_in')).toBeTruthy();
    expect(lr.io.find((io: any) => io.name === 'tex_out')).toBeTruthy();
    // The full authored param set is declared.
    const names = lr.params.map((p: any) => p.name).sort();
    expect(names).toEqual(['deband', 'debug_view', 'max_width', 'point_radius',
                           'recover', 'retarget', 'sensitivity', 'solidify',
                           'strength', 'target_width']);
  });

  it('renders a non-solid frame (the multi-pass pipeline dispatches cleanly)', async () => {
    const r = await runChain('lr_render', { strength: 1.0 }, 'line_reconstruct_render');
    expect(r.success).toBe(true);
    r.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
  });

  it('strength 0 is a pass-through (output == input)', async () => {
    const r = await runChain('lr_identity', { strength: 0.0 }, 'line_reconstruct_identity');
    expect(r.success).toBe(true);
    r.trace('out').expectSameAs(r.trace('in'), 2);
  });
});
