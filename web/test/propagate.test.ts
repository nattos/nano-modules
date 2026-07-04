import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for filter.sim.propagate (nano bundle) — the outward-propagation engine
 * (the Simulant successor). It seeds a feedback field from the INPUT'S STRUCTURE
 * (its luma — via frame-difference and a built-in flicker / feed), advects that
 * structure OUTWARD as expanding concentric fronts, diffuses + decays it, and
 * thresholds the fronts into contour lines over the input.
 *
 * Probe strategy: the effect is stateful and its exact pattern is chaotic, so
 * the assertions key off ROBUST invariants rather than a golden image, and use a
 * LOCALIZED static feature (a rect) so the propagation is expanding rings rather
 * than a degenerate flood (a monotone gradient would advect to a uniform fill):
 *   - No seeding → the field decays to zero → `debug_show_field` is black and the
 *     composite is just the dimmed input.
 *   - Continuously feeding the rect's structure → it propagates outward → the
 *     tone-mapped field crosses the contour levels → contour lines appear.
 *   - A luma jump (frame-difference) seeds the field with flicker/feed off.
 *   - The have_history guard emits NO ghost seed on the first frame.
 */

describe('filter.sim.propagate E2E', () => {
  jest.setTimeout(60000);

  // testonly carries source.solid_color + debug.motion_rect; nano carries propagate.
  const MODULES = ['com.nano.testonly', 'com.nano.nano'];
  const W = 128, H = 128;

  // A LOCALIZED static feature: a centred white rect on black. Its structure
  // propagates outward as expanding rings (unlike a monotone gradient, which
  // would advect to a uniform flood).
  const rectSketch = (pr: Record<string, unknown>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
        params: { color: [0, 0, 0] } },
      { type: 'module', module_type: 'debug.motion_rect', instance_key: 'rc@0',
        params: { size: 0.15, speed: 0.0, color: [1, 1, 1] } },
      { type: 'module', module_type: 'filter.sim.propagate', instance_key: 'pr@0', params: pr },
    ],
  } as Sketch);

  // A flat solid input — used where we drive the seed ourselves (frame-diff /
  // the first-frame guard) and only need to know the field is / isn't lit.
  const solidSketch = (pr: Record<string, unknown>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [0.5, 0.5, 0.5] } },
      { type: 'module', module_type: 'filter.sim.propagate', instance_key: 'pr@0', params: pr },
    ],
  } as Sketch);

  const run = (id: string, sketch: Sketch, waitFrames = 20) =>
    runEngineTest({
      width: W, height: H,
      modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames, captureTraceIds: ['out'], dumpName: id,
    });

  it('propagates the input structure into expanding contour lines', async () => {
    // No seed → field 0 → just the dimmed rect, no rings.
    const off = await run('pr_off', rectSketch({
      flicker: 0.0, flicker_rate: 0.0, feed: 0.0, input_mix: 0.4,
    }));
    // Feed the rect's structure → it propagates outward → contour rings appear.
    const on = await run('pr_on', rectSketch({
      flicker: 0.0, flicker_rate: 0.0, feed: 0.35, speed: 0.3, damping: 0.35,
      level: 0.2, thickness: 0.05, line_count: 3, input_mix: 0.4, line_color: [1, 1, 1],
    }));
    expect(off.success && on.success).toBe(true);
    on.trace('out').expectDifferentFrom(off.trace('out'), 100);
    // Bright white line pixels (well above the dimmed input) exist.
    on.trace('out').expectCoverage(c => c.r > 200 && c.g > 200 && c.b > 200, { min: 0.002 });
  });

  it('debug field lights only when seeded', async () => {
    const off = await run('pr_field_off', rectSketch({
      flicker: 0.0, flicker_rate: 0.0, feed: 0.0, debug_show_field: true,
    }));
    const on = await run('pr_field_on', rectSketch({
      flicker: 0.0, flicker_rate: 0.0, feed: 0.35, speed: 0.3, debug_show_field: true,
    }));
    expect(off.success && on.success).toBe(true);
    // No seed → F == 0 everywhere → the field view is solid black.
    off.trace('out').expectUniformColor({ r: 0, g: 0, b: 0 }, 6);
    // Seeded → the propagated structure lights the field.
    on.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 12);
    on.trace('out').expectDifferentFrom(off.trace('out'), 100);
  });

  it('frame-difference seeds the field when the input changes (flicker off)', async () => {
    // Flicker + feed off + debug field: the ONLY thing that can light the field
    // is a per-pixel change vs the previous frame. Phase 1 settles on a static
    // solid (black field); phase 2 jumps the source luma → the field lights up.
    const p = {
      flicker: 0.0, flicker_rate: 0.0, feed: 0.0, debug_show_field: true,
      change_threshold: 0.04, change_gain: 1.0,
    };
    const r = await runEngineMultiPhaseTest({
      width: W, height: H,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'pr_fd', sketch: solidSketch(p) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'pr_fd' } },
            ]},
          ], waitFrames: 12, captureTraceIds: ['out'] },
        // Big luma jump (0.5 → 0.05) → every pixel changes → the field lights.
        { commands: [
            { type: 'setParam', sketchId: 'pr_fd', colIdx: 0, chainIdx: 0,
              paramKey: 'color', value: [0.05, 0.05, 0.05] },
          ], waitFrames: 6, captureTraceIds: ['out'] },
      ],
      dumpName: 'pr_framediff',
    });
    expect(r.success).toBe(true);
    r.phases[0].trace('out').expectUniformColor({ r: 0, g: 0, b: 0 }, 6);
    r.phases[1].trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 12);
    r.phases[1].trace('out').expectDifferentFrom(r.phases[0].trace('out'), 50);
  });

  it('does not seed on the first frame (have_history guard)', async () => {
    // A bright static input (0.5) with flicker + feed off. Without the guard,
    // frame 1 would diff luma against a zeroed field (0.5 − 0 > threshold) and
    // seed a global front. With the guard, frame 1 has no previous frame to
    // compare → no seed → the field view stays black.
    const r = await run('pr_ghost', solidSketch({
      flicker: 0.0, flicker_rate: 0.0, feed: 0.0, debug_show_field: true,
      change_threshold: 0.02, change_gain: 1.0,
    }), 1);
    expect(r.success).toBe(true);
    r.trace('out').expectUniformColor({ r: 0, g: 0, b: 0 }, 6);
  });
});
