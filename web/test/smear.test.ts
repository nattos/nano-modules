import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for filter.blur.smear — "Smear", a directional Pixulant (nano bundle).
 *
 * A flat solid is invisible through a blur/scatter, so the transform is exercised
 * by chaining a deterministic structured generator (source.grid, from core) → smear
 * and comparing parameter settings. Each run also traces the smear node's own INPUT
 * (chain_entry side:'input') so passthrough / dissolve can be checked against the
 * exact input in a single render. motion=0 pins the scatter salt for stable frames.
 */
describe('Smear (filter.blur.smear) E2E', () => {
  jest.setTimeout(60000);

  const W = 128, H = 128;
  const MODULES = ['com.nano.testonly', 'com.nano.core', 'com.nano.nano'];

  // source.grid → smear. Traces the smear node's input ('in') and the final
  // output ('out'). params override the schema defaults.
  const runChain = (id: string, params: Record<string, number>, dump: string,
                    waitFrames = 8) => {
    const sketch: Sketch = {
      anchor: null,
      wires: [],
      chain: [
        { type: 'module', module_type: 'source.grid', instance_key: 'grid@0', params: {} },
        { type: 'module', module_type: 'filter.blur.smear', instance_key: 'sm@0', params },
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

  it('registers and renders a blurred grid (differs from its input)', async () => {
    const r = await runChain('sm_r', { length: 0.6, width: 0.4, samples: 16 }, 'smear_render');
    expect(r.success).toBe(true);
    r.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    r.trace('out').expectDifferentFrom(r.trace('in'), 100);  // blur actually softened the grid
  });

  it('blur is directional — the streak axis follows angle', async () => {
    // Long thin streak so the axis dominates: horizontal (angle 0) vs vertical (0.5 → θ=π/2).
    const horiz = await runChain('sm_h', { angle: 0.0, length: 0.8, width: 0.03, tail: 0.0, samples: 16 }, 'smear_angle_h');
    const vert  = await runChain('sm_v', { angle: 0.5, length: 0.8, width: 0.03, tail: 0.0, samples: 16 }, 'smear_angle_v');
    expect(horiz.success).toBe(true);
    expect(vert.success).toBe(true);
    vert.trace('out').expectDifferentFrom(horiz.trace('out'), 100);
  });

  it('tail biases the kernel (symmetric blob vs one-sided streak)', async () => {
    const blob   = await runChain('sm_t0', { angle: 0.25, length: 0.8, width: 0.05, tail: 0.0, samples: 16 }, 'smear_tail_0');
    const streak = await runChain('sm_t1', { angle: 0.25, length: 0.8, width: 0.05, tail: 1.0, samples: 16 }, 'smear_tail_1');
    expect(blob.success).toBe(true);
    expect(streak.success).toBe(true);
    streak.trace('out').expectDifferentFrom(blob.trace('out'), 100);
  });

  it('perspective tilt ramps the minor width across the frame', async () => {
    // Wide minor axis so the per-pixel width scaling is visible; short major reach.
    const flat = await runChain('sm_k0', { angle: 0.0, length: 0.1, width: 0.6, tilt: 0.0, samples: 16 }, 'smear_tilt_0');
    const tilt = await runChain('sm_k1', { angle: 0.0, length: 0.1, width: 0.6, tilt: 1.0, samples: 16 }, 'smear_tilt_1');
    expect(flat.success).toBe(true);
    expect(tilt.success).toBe(true);
    tilt.trace('out').expectDifferentFrom(flat.trace('out'), 100);
  });

  it('zero reach is a passthrough (≈ the input)', async () => {
    const r = await runChain('sm_p', { length: 0.0, width: 0.0, samples: 16 }, 'smear_passthrough');
    expect(r.success).toBe(true);
    // A zero-reach separable pass samples texel centres → output ≈ input.
    const diff = r.trace('out').diffCount(r.trace('in'), 6);
    expect(diff).toBeLessThan(W * H * 0.02);
  });

  it('scatter mode dissolves the grid into differenced grain', async () => {
    const r = await runChain('sm_s', { mode: 1, length: 0.5, width: 0.2, dive: 1.0, motion: 0.0 }, 'smear_scatter');
    expect(r.success).toBe(true);
    r.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    r.trace('out').expectDifferentFrom(r.trace('in'), 100);
  });

  it('scatter motion animates the field over time', async () => {
    const early = await runChain('sm_m0', { mode: 1, length: 0.5, width: 0.2, dive: 1.0, motion: 1.0 }, 'smear_motion_early', 4);
    const late  = await runChain('sm_m1', { mode: 1, length: 0.5, width: 0.2, dive: 1.0, motion: 1.0 }, 'smear_motion_late', 60);
    expect(early.success).toBe(true);
    expect(late.success).toBe(true);
    late.trace('out').expectDifferentFrom(early.trace('out'), 50);
  });
});
