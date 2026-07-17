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
// black; color_blend=1 renders the solid color instead).
const BASE: Record<string, unknown> = {
  count: 3000, mode: 0 /* Velocity */, shape_kind: 1 /* Gaussian */, size: 0.8,
  speed: 2.0, momentum: 0.0, jitter: 0.0, drag: 0.0, life: 6.0, life_jitter: 0.2,
  noise_speed: 0.5, eddy_evolve: 0.5,
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
});
