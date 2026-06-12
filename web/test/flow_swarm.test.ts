import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for video.flow_swarm (nano bundle) + the new `flow_field`
 * struct rail. flow_swarm consumes a velocity field (produced here by
 * phase_fold) and advects a GPU particle pool along it.
 *
 * Chain: texture_input → phase_fold (writes flow_field) → flow_swarm
 *        (reads flow_field_in) → texture_output.
 *
 * Under test:
 *  1. The rail transports the velocity texture end-to-end: a wired chain
 *     renders a particle swarm that differs from the bare phase_fold
 *     portrait (the swarm actually painted over it).
 *  2. The flow drives the swarm: a chain WITH the rail differs from one
 *     WITHOUT it — with flow the particles advect, without they sit frozen
 *     at their seed positions. (Same as render-outputs.test.ts's rail proof.)
 *  3. The swarm is live: its output drifts across frames as particles flow.
 *  4. Unwired fallback: with no flow rail the swarm still renders (no crash).
 */

const FLOW_SCHEMA = {
  type: 'object',
  fields: { velocity: { type: 'texture' } },
};

// phase_fold cell with a clear limit cycle, flow clock frozen for determinism.
const PF: Record<string, unknown> = {
  eccentricity: 0.5, lobedness: 0.3, flow_speed: 0.0,
  show_streamlines: false, show_limit_cycle: false,
};

// Swarm isolated over a black backdrop (input_alpha=0) so assertions key on
// the particles themselves. Pure flow motion (no jitter/drag), captured color.
const SWARM: Record<string, unknown> = {
  count: 3000, size: 0.02, speed: 4.0, momentum: 0.0,
  jitter: 0.0, drag: 0.0, life: 6.0, life_jitter: 0.2,
  color_blend: 0.0, blend_mode: 0 /* Add */, opacity: 1.0,
  input_alpha: 0.0, seed: 1,
};

function buildChain(withFlow: boolean): Sketch {
  return {
    anchor: null,
    columns: [{
      name: 'main',
      rails: withFlow ? [{
        id: 'flow_rail',
        name: 'Flow',
        dataType: { kind: 'struct', schema: FLOW_SCHEMA },
      }] : [],
      chain: [
        { type: 'texture_input', id: 'in' },
        {
          type: 'module',
          module_type: 'video.phase_fold',
          instance_key: 'pf@0',
          params: PF,
          taps: withFlow
            ? [{ railId: 'flow_rail', fieldPath: 'flow_field', direction: 'write' }]
            : [],
        },
        {
          type: 'module',
          module_type: 'video.flow_swarm',
          instance_key: 'sw@0',
          params: SWARM,
          taps: withFlow
            ? [{ railId: 'flow_rail', fieldPath: 'flow_field_in', direction: 'read' }]
            : [],
        },
        { type: 'texture_output', id: 'out' },
      ],
    }],
  };
}

// Bare phase_fold portrait (no swarm) — the comparison baseline for test 1.
function buildGeneratorOnly(): Sketch {
  return {
    anchor: null,
    columns: [{
      name: 'main',
      chain: [
        { type: 'texture_input', id: 'in' },
        { type: 'module', module_type: 'video.phase_fold', instance_key: 'pf@0', params: PF },
        { type: 'texture_output', id: 'out' },
      ],
    }],
  };
}

const isActive = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b > 24;

describe('video.flow_swarm + flow_field rail E2E', () => {
  jest.setTimeout(60000);

  it('renders a swarm over the flow_field (wired) distinct from the bare portrait', async () => {
    const swarm = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'fs_wired', sketch: buildChain(true) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_wired' } },
        ]},
      ],
      waitFrames: 10,
      captureTraceIds: ['out'],
      dumpName: 'flow_swarm_wired',
    });
    expect(swarm.success).toBe(true);

    // With input_alpha=0 the backdrop is black, so any lit pixels are
    // particles. A healthy 3000-particle swarm covers a meaningful area.
    const active = swarm.trace('out').countPixels(isActive);
    expect(active).toBeGreaterThan(150);

    // And it must NOT look like the bare phase_fold portrait.
    const gen = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'fs_gen', sketch: buildGeneratorOnly() },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_gen' } },
        ]},
      ],
      waitFrames: 10,
      captureTraceIds: ['out'],
      dumpName: 'flow_swarm_generator',
    });
    expect(gen.success).toBe(true);
    swarm.trace('out').expectDifferentFrom(gen.trace('out'), 100);
  });

  it('the flow rail drives the swarm (wired differs from unwired-fallback)', async () => {
    // Same modules, params, frame count — the ONLY difference is whether the
    // flow_field rail is wired. With flow the particles advect along the
    // field; without (zero-field fallback) they sit at their seed positions.
    const withFlow = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'fs_on', sketch: buildChain(true) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_on' } },
        ]},
      ],
      waitFrames: 24,
      captureTraceIds: ['out'],
      dumpName: 'flow_swarm_rail_on',
    });
    expect(withFlow.success).toBe(true);

    const noFlow = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'fs_off', sketch: buildChain(false) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_off' } },
        ]},
      ],
      waitFrames: 24,
      captureTraceIds: ['out'],
      dumpName: 'flow_swarm_rail_off',
    });
    // Fallback path must still render cleanly (no crash, particles present).
    expect(noFlow.success).toBe(true);
    expect(noFlow.trace('out').countPixels(isActive)).toBeGreaterThan(100);

    // The flow moved the particles → the two frames diverge.
    withFlow.trace('out').expectDifferentFrom(noFlow.trace('out'), 60);
  });

  it('the swarm is live — output drifts across frames', async () => {
    const r = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      dumpName: 'flow_swarm_drift',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'fs_drift', sketch: buildChain(true) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_drift' } },
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
});
