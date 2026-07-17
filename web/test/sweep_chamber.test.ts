import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for source.particles.sweep_chamber (nano bundle) — the
 * double_chamber successor. Grows with the effect's milestones; currently:
 *  1. Generator smoke: with no input the sim free-flows on the curl-noise
 *     field and still renders particles.
 *  2. The swarm is live: output drifts across frames.
 *  3. The noise field drives motion: noise_speed 0 (still) vs high differ.
 */

// Solid white particles at a visible size over a black generator backdrop so
// assertions key on the particles themselves (no input → captured color is
// black; color_blend=1 renders the solid color instead). Lines off by
// default so the core-motion tests stay line-free.
const BASE: Record<string, unknown> = {
  count: 3000, mode: 0 /* Velocity */, shape_kind: 1 /* Gaussian */, size: 0.8,
  speed: 2.0, momentum: 0.0, jitter: 0.0, drag: 0.0, life: 6.0, life_jitter: 0.2,
  noise_speed: 0.5, eddy_evolve: 0.5, l_count: 0, spawn_on_line: 0.0,
  boundary_death: 0.0, color_blend: 1.0, solid_color: [1, 1, 1],
  blend_mode: 0 /* Add */, opacity: 1.0, input_alpha: 0.0, seed: 1,
};

function buildChain(params: Record<string, unknown> = {}): Sketch {
  return {
    anchor: null,
    wires: [],
    chain: [{
      type: 'module',
      module_type: 'source.particles.sweep_chamber',
      instance_key: 'sc@0',
      params: { ...BASE, ...params },
    }],
  };
}

// Gradient producer (core bundle): a full-softness white→black horizontal
// ramp — every luma is present, so a narrow sweep window captures a vertical
// band whose position follows sweep_center.
function buildGradientChain(params: Record<string, unknown> = {}): Sketch {
  return {
    anchor: null,
    wires: [],
    chain: [
      {
        type: 'module',
        module_type: 'source.gradient',
        instance_key: 'grad@0',
        params: { angle: 0.0, offset: 0.0, softness: 1.0,
                  color_a: [1, 1, 1], color_b: [0, 0, 0] },
      },
      {
        type: 'module',
        module_type: 'source.particles.sweep_chamber',
        instance_key: 'sc@0',
        params: { ...BASE, ...params },
      },
    ],
  };
}

const isActive = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b > 24;

describe('source.particles.sweep_chamber E2E', () => {
  jest.setTimeout(60000);

  const run = (id: string, params: Record<string, unknown>, frames: number) =>
    runEngineTest({
      width: 96, height: 96,
      modules: ['com.nano.testonly', 'com.nano.nano'],
      commands: [
        { type: 'createSketch', sketchId: id, sketch: buildChain(params) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames: frames, captureTraceIds: ['out'], dumpName: id,
    });

  it('renders a swarm as a generator (no input wired)', async () => {
    const r = await run('sc_gen', {}, 12);
    expect(r.success).toBe(true);
    // Black backdrop + white particles: any lit pixels are the swarm.
    expect(r.trace('out').countPixels(isActive)).toBeGreaterThan(150);
  });

  it('is live — output drifts across frames', async () => {
    const r = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nano.testonly', 'com.nano.nano'],
      dumpName: 'sc_drift',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'sc_drift', sketch: buildChain({}) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'sc_drift' } },
            ]},
          ],
          waitFrames: 6, captureTraceIds: ['out'],
        },
        { waitFrames: 30, captureTraceIds: ['out'] },
      ],
    });
    expect(r.success).toBe(true);
    r.phases[1].trace('out').expectDifferentFrom(r.phases[0].trace('out'), 40);
  });

  it('the curl-noise field drives motion (noise_speed 0 vs high differ)', async () => {
    const still  = await run('sc_ns_off', { noise_speed: 0.0 }, 24);
    const moving = await run('sc_ns_on',  { noise_speed: 1.0 }, 24);
    expect(still.success).toBe(true);
    expect(moving.success).toBe(true);
    expect(moving.trace('out').countPixels(isActive)).toBeGreaterThan(100);
    moving.trace('out').expectDifferentFrom(still.trace('out'), 40);
  });

  // ---- Sweep / image coupling (over a gradient: all lumas present) ----

  const runGrad = (id: string, params: Record<string, unknown>, frames: number) =>
    runEngineTest({
      width: 96, height: 96,
      modules: ['com.nano.testonly', 'com.nano.core', 'com.nano.nano'],
      commands: [
        { type: 'createSketch', sketchId: id, sketch: buildGradientChain(params) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames: frames, captureTraceIds: ['out'], dumpName: id,
    });

  // Strong image coupling, becalmed noise field: where particles end up is
  // dominated by the swept-luma gradient.
  const COUPLED: Record<string, unknown> = {
    to_image: 4.0, to_image_curl: 0.0, noise_speed: 0.02,
    momentum: 0.3, speed: 2.0, sweep_width: 0.2, sweep_soft: 0.3,
  };

  it('mid-sweep captures the image (differs from the fully-off endpoint)', async () => {
    const mid = await runGrad('sc_sweep_mid', { ...COUPLED, sweep_center: 0.5 }, 30);
    const off = await runGrad('sc_sweep_end', { ...COUPLED, sweep_center: 0.0 }, 30);
    expect(mid.success).toBe(true);
    expect(off.success).toBe(true);
    expect(mid.trace('out').countPixels(isActive)).toBeGreaterThan(100);
    // Endpoint = nothing captured → free flow; mid = particles gathered onto
    // the captured band. Distributions clearly differ.
    mid.trace('out').expectDifferentFrom(off.trace('out'), 60);
  });

  it('the sweep position moves the captured band (0.3 vs 0.8 differ)', async () => {
    const lo = await runGrad('sc_sweep_lo', { ...COUPLED, sweep_center: 0.3 }, 30);
    const hi = await runGrad('sc_sweep_hi', { ...COUPLED, sweep_center: 0.8 }, 30);
    expect(lo.success).toBe(true);
    expect(hi.success).toBe(true);
    expect(lo.trace('out').countPixels(isActive)).toBeGreaterThan(100);
    expect(hi.trace('out').countPixels(isActive)).toBeGreaterThan(100);
    lo.trace('out').expectDifferentFrom(hi.trace('out'), 60);
  });

  it('both sweep endpoints read as "captures nothing" (0 vs 1 similar in coverage)', async () => {
    // Not pixel-identical (different RNG histories), but BOTH endpoints must
    // free-flow — neither may pile particles onto image features. Compare
    // coverage rather than exact pixels.
    const lo = await runGrad('sc_end_lo', { ...COUPLED, sweep_center: 0.0 }, 30);
    const hi = await runGrad('sc_end_hi', { ...COUPLED, sweep_center: 1.0 }, 30);
    expect(lo.success).toBe(true);
    expect(hi.success).toBe(true);
    const loActive = lo.trace('out').countPixels(isActive);
    const hiActive = hi.trace('out').countPixels(isActive);
    expect(loActive).toBeGreaterThan(100);
    expect(hiActive).toBeGreaterThan(100);
    // Similar spread: neither endpoint collapsed into a tight captured band.
    expect(Math.abs(loActive - hiActive)).toBeLessThan(Math.max(loActive, hiActive) * 0.5);
  });

  // ---- Lines (tracers) ----

  it('lines render (l_count on vs off differ, and add coverage)', async () => {
    const params = { ...COUPLED, sweep_center: 0.5, opacity: 0.0 };  // lines only
    const off = await runGrad('sc_lines_off', { ...params, l_count: 0 }, 24);
    const on  = await runGrad('sc_lines_on',
      { ...params, l_count: 24, l_opacity: 1.0, l_width: 0.4, l_grip_alpha: 0.0 }, 24);
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    // Particles are invisible (opacity 0): everything lit is a line.
    expect(on.trace('out').countPixels(isActive)).toBeGreaterThan(80);
    on.trace('out').expectDifferentFrom(off.trace('out'), 60);
  });

  it('spawn-on-line concentrates fresh particles (short life, on vs off differ)', async () => {
    // Short-lived particles respawn constantly; with spawn_on_line they land
    // on the (gripped, mid-sweep) tracer lines instead of the central disc.
    const params = {
      ...COUPLED, sweep_center: 0.5, life: 0.5, life_jitter: 0.2,
      l_count: 24, l_opacity: 0.0,  // lines invisible — only their pull shows
      momentum: 0.9, speed: 0.5,
    };
    const off = await runGrad('sc_sol_off', { ...params, spawn_on_line: 0.0 }, 30);
    const on  = await runGrad('sc_sol_on',  { ...params, spawn_on_line: 1.0 }, 30);
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    expect(on.trace('out').countPixels(isActive)).toBeGreaterThan(60);
    on.trace('out').expectDifferentFrom(off.trace('out'), 50);
  });
});
