import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for filter.sim.propagate (nano bundle) — the wave-propagation engine
 * (the Simulant successor). A persistent damped 2D wave field: changing pixels
 * (frame-difference) + a built-in flicker seed velocity impulses; ripples travel
 * outward and decay; the crests threshold into contour lines over the input.
 *
 * Probe strategy: the effect is stateful and its exact line pattern is chaotic,
 * so the assertions key off ROBUST invariants rather than a golden image:
 *   - With NO seeding (flicker 0, static input) the field decays to zero, so the
 *     output is the uniformly-dimmed input, and `debug_show_field` is solid black.
 *   - Flicker (Poisson at a high rate → fires ~every frame) injects a grainy
 *     global impulse, so a STATIC image radiates: the field lights up and the
 *     composite breaks the uniform frame.
 *   - A luma jump on the source (frame-difference) seeds a ripple with flicker
 *     off — isolating the change-detection path.
 *   - On the very first frame there is no previous frame to diff, so the
 *     have_history guard must emit NO ghost ripple (field stays black) even
 *     though the input is bright.
 */

describe('filter.sim.propagate E2E', () => {
  jest.setTimeout(60000);

  const MODULES = ['com.nano.testonly', 'com.nano.nano'];
  const W = 96, H = 96;

  // source.solid_color(gray) → filter.sim.propagate. A generator feeds the
  // stateful effect; solid_color has no motion, so waves come only from what
  // the params induce (flicker / a param-driven color change).
  const sketch = (params: Record<string, unknown>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [0.5, 0.5, 0.5] } },
      { type: 'module', module_type: 'filter.sim.propagate', instance_key: 'pr@0',
        params },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, unknown>, waitFrames = 20) =>
    runEngineTest({
      width: W, height: H,
      modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: sketch(params) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames, captureTraceIds: ['out'], dumpName: id,
    });

  it('registers + renders; flicker makes a static image ripple into structure', async () => {
    // No seeding: field decays to 0 → output is the uniformly dimmed input.
    // solid 0.5 → 128, input_mix 0.5 → 64.
    const off = await run('pr_off', {
      flicker: 0.0, flicker_rate: 0.0, sim_scale: 0.25, input_mix: 0.5,
    });
    // Flicker firing ~every frame → the static image radiates → the frame is
    // no longer uniform (waves + contour lines break it up).
    const on = await run('pr_on', {
      flicker: 1.0, flicker_rate: 1.0, sim_scale: 0.25, input_mix: 0.5,
      level: 0.14, thickness: 0.05, line_color: [1, 1, 1],
    });
    expect(off.success && on.success).toBe(true);

    off.trace('out').expectUniformColor({ r: 64, g: 64, b: 64 }, 12);
    on.trace('out').expectDifferentFrom(off.trace('out'), 30);
    on.trace('out').expectNotSolidColor({ r: 64, g: 64, b: 64 }, 24);
  });

  it('debug field shows a non-zero wave field only when seeded', async () => {
    const off = await run('pr_field_off', {
      flicker: 0.0, flicker_rate: 0.0, sim_scale: 0.25, debug_show_field: true,
    });
    const on = await run('pr_field_on', {
      flicker: 1.0, flicker_rate: 1.0, sim_scale: 0.25, debug_show_field: true,
    });
    expect(off.success && on.success).toBe(true);

    // No seed → u == 0 everywhere → the field view is solid black.
    off.trace('out').expectUniformColor({ r: 0, g: 0, b: 0 }, 6);
    // Seeded → red/blue crests + troughs.
    on.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 12);
    on.trace('out').expectDifferentFrom(off.trace('out'), 50);
  });

  it('frame-difference seeds a ripple when the input changes (flicker off)', async () => {
    // Flicker off + debug field: the ONLY thing that can light the field is a
    // per-pixel change vs the previous frame. Phase 1 settles on a static
    // input (black field); phase 2 jumps the source luma → a global ripple.
    const p = {
      flicker: 0.0, flicker_rate: 0.0, sim_scale: 0.25, debug_show_field: true,
      change_threshold: 0.04, change_gain: 1.0,
    };
    const r = await runEngineMultiPhaseTest({
      width: W, height: H,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'pr_fd', sketch: sketch(p) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'pr_fd' } },
            ]},
          ], waitFrames: 12, captureTraceIds: ['out'] },
        // Big luma jump (0.5 → 0.05) → every cell changes → a seeded ripple.
        { commands: [
            { type: 'setParam', sketchId: 'pr_fd', colIdx: 0, chainIdx: 0,
              paramKey: 'color', value: [0.05, 0.05, 0.05] },
          ], waitFrames: 6, captureTraceIds: ['out'] },
      ],
      dumpName: 'pr_framediff',
    });
    expect(r.success).toBe(true);

    // Static, unseeded → black field.
    r.phases[0].trace('out').expectUniformColor({ r: 0, g: 0, b: 0 }, 6);
    // The change seeded the field → it's no longer black, and clearly differs.
    r.phases[1].trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 12);
    r.phases[1].trace('out').expectDifferentFrom(r.phases[0].trace('out'), 50);
  });

  it('does not emit a ghost ripple on the first frame (have_history guard)', async () => {
    // A bright static input (0.5) with flicker off. Without the have_history
    // guard, frame 1 would diff luma against a zeroed field (0.5 − 0 > threshold)
    // and seed a global ripple. With the guard, frame 1 has no previous frame to
    // compare → no seed → the field view stays black.
    const r = await run('pr_ghost', {
      flicker: 0.0, flicker_rate: 0.0, sim_scale: 0.25, debug_show_field: true,
      change_threshold: 0.02, change_gain: 1.0,
    }, 1);
    expect(r.success).toBe(true);
    r.trace('out').expectUniformColor({ r: 0, g: 0, b: 0 }, 6);
  });
});
