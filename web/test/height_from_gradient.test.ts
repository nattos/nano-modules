import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for video.height_from_gradient (nano bundle) — GPU gradient-
 * domain height reconstruction (multigrid Poisson solve).
 *
 * The effect is DETERMINISTIC per frame (no cross-frame state, no RNG), so
 * two separate captures with different params are directly comparable.
 *
 * Under test:
 *  1. Registers + renders: the six-pass pipeline (gradient → divergence →
 *     restrict → jacobi → prolong → present) dispatches cleanly and produces
 *     a non-black image from a solid input. (A solid input still yields a
 *     STRUCTURED height: the radial gradient field's divergence is non-trivial,
 *     so the reconstruction is a relief, not a flat plane.)
 *  2. Relief carries reconstructed structure: relief_scale=0 flattens the
 *     surface (uniform shade); relief_scale>0 lights the reconstructed slopes.
 *     The two must differ — proving the solver produced spatial height.
 *  3. present_mode changes the look: Hillshade vs Normals differ.
 *  4. debug_show_gradient overlays the source gradient field (differs from
 *     the normal hillshade output).
 */

// A solid mid-grey background — a deterministic, static input. Its luma is
// constant, but the radial gradient field still has a non-trivial divergence,
// so the height reconstruction is a smooth radial relief.
function buildSketch(sketchId: string, params: Record<string, unknown>): Sketch {
  return {
    anchor: null,
    columns: [{
      name: 'main',
      chain: [
        { type: 'texture_input', id: 'in' },
        {
          type: 'module',
          module_type: 'generator.solid_color',
          instance_key: 'bg@0',
          params: { color: [0.4, 0.55, 0.7] },
        },
        {
          type: 'module',
          module_type: 'video.height_from_gradient',
          instance_key: 'hfg@0',
          params,
        },
        { type: 'texture_output', id: 'out' },
      ],
    }],
  };
}

async function render(sketchId: string, params: Record<string, unknown>, dumpName: string) {
  const result = await runEngineTest({
    width: 64, height: 64,
    modules: ['com.nattos.testonly', 'com.nattos.nano'],
    commands: [
      { type: 'createSketch', sketchId, sketch: buildSketch(sketchId, params) },
      { type: 'setTracePoints', tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId } },
      ]},
    ],
    waitFrames: 6,
    captureTraceIds: ['out'],
    dumpName,
  });
  expect(result.success).toBe(true);
  return result.trace('out');
}

describe('video.height_from_gradient E2E', () => {
  jest.setTimeout(40000);

  it('registers and renders a non-black reconstruction', async () => {
    const out = await render('hfg_smoke', {}, 'hfg_smoke');
    // The six-pass solve produced a lit relief — not an all-black frame.
    out.expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
  });

  it('reconstructs relief from the radial gradient (relief_scale drives it)', async () => {
    // relief_scale=0 → flat surface → uniform shade.
    const flat = await render('hfg_flat', { relief_scale: 0.0 }, 'hfg_flat');
    flat.expectUniformColor({}, 4);
    // relief_scale>0 → the reconstructed slopes light up → spatial variation.
    const relief = await render('hfg_relief', { relief_scale: 0.7 }, 'hfg_relief');
    relief.expectDifferentFrom(flat, 50);
  });

  it('core_radius smooths the anchor singularity (changes the reconstruction)', async () => {
    // The radial field is singular at the anchor (div ~ 1/r). core_radius
    // suppresses the field magnitude near the center, replacing the spike with
    // a smooth dome — so the reconstructed relief differs from the raw field.
    const raw    = await render('hfg_core_off', { core_radius: 0.0, relief_scale: 0.7 }, 'hfg_core_off');
    const smooth = await render('hfg_core_on',  { core_radius: 0.4, relief_scale: 0.7 }, 'hfg_core_on');
    smooth.expectDifferentFrom(raw, 50);
  });

  it('present_mode changes the visualization (Hillshade vs Normals)', async () => {
    const hill = await render('hfg_hill', { present_mode: 0, relief_scale: 0.7 }, 'hfg_hill');
    const norm = await render('hfg_norm', { present_mode: 2, relief_scale: 0.7 }, 'hfg_norm');
    norm.expectDifferentFrom(hill, 50);
  });

  it('debug_show_gradient overlays the source gradient field', async () => {
    const normal = await render('hfg_dbg_off', { debug_show_gradient: false }, 'hfg_dbg_off');
    const debug  = await render('hfg_dbg_on',  { debug_show_gradient: true },  'hfg_dbg_on');
    debug.expectDifferentFrom(normal, 50);
  });
});
