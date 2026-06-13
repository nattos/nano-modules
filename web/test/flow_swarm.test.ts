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
// Gaussian shape at a visible size (size is now a quadratic [0,1] slider).
const SWARM: Record<string, unknown> = {
  count: 3000, mode: 0 /* Velocity */, shape_kind: 1 /* Gaussian */, size: 0.8,
  speed: 4.0, momentum: 0.0, jitter: 0.0, drag: 0.0, life: 6.0, life_jitter: 0.2,
  color_blend: 0.0, blend_mode: 0 /* Add */, opacity: 1.0, input_alpha: 0.0,
  seed: 1,
};

function buildChain(withFlow: boolean, swarm: Record<string, unknown> = {}): Sketch {
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
          params: { ...SWARM, ...swarm },
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

  it('force mode advects the swarm (field as acceleration on a mass)', async () => {
    // mode=Force, light weight: particles integrate the field as acceleration.
    // Confirm the chain runs and the swarm is live (drifts across frames).
    const r = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      dumpName: 'flow_swarm_force',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'fs_force',
              sketch: buildChain(true, { mode: 1, weight: 0.5, drag: 0.2 }) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_force' } },
            ]},
          ],
          waitFrames: 8, captureTraceIds: ['out'],
        },
        { waitFrames: 30, captureTraceIds: ['out'] },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.phases[1].trace('out').countPixels(isActive)).toBeGreaterThan(100);
    r.phases[1].trace('out').expectDifferentFrom(r.phases[0].trace('out'), 30);
  });

  it('pull settles the swarm onto the field (force mode, pull on vs off)', async () => {
    // Force mode lets particles overshoot the stable zone. `pull` bleeds their
    // velocity back toward the field flow each frame, settling them onto the
    // limit cycle — so the dynamics (and the resulting frame) clearly differ.
    const force = { mode: 1, weight: 0.4, drag: 0.1, speed: 5.0 };
    const run = (id: string, pull: number) => runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: id, sketch: buildChain(true, { ...force, pull }) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames: 28, captureTraceIds: ['out'], dumpName: id,
    });

    const free = await run('fs_pull_off', 0.0);
    const glued = await run('fs_pull_on', 1.0);
    expect(free.success).toBe(true);
    expect(glued.success).toBe(true);
    // Both render a live swarm; the pull changes where particles end up.
    expect(glued.trace('out').countPixels(isActive)).toBeGreaterThan(100);
    glued.trace('out').expectDifferentFrom(free.trace('out'), 50);
  });

  it('undertow changes the look (depth-gated tint + reversed flow)', async () => {
    // split=0 → no undertow (portrait-colored particles flowing forward).
    // split=1 → all particles undertow: blue tint + reversed/curled motion.
    const UNDERTOW = {
      undertow_polarity: -1.0, undertow_curl: 1.0,
      undertow_tint: [0.1, 0.4, 1.0], undertow_alpha: 1.0,
      color_blend: 0.0,
    };
    const off = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'fs_ut_off',
          sketch: buildChain(true, { ...UNDERTOW, undertow_split: 0.0 }) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_ut_off' } },
        ]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: 'flow_swarm_ut_off',
    });
    expect(off.success).toBe(true);

    const on = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'fs_ut_on',
          sketch: buildChain(true, { ...UNDERTOW, undertow_split: 1.0 }) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'fs_ut_on' } },
        ]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: 'flow_swarm_ut_on',
    });
    expect(on.success).toBe(true);
    expect(on.trace('out').countPixels(isActive)).toBeGreaterThan(100);

    // Tint (blue) + reversed/curled motion → a clearly different frame.
    on.trace('out').expectDifferentFrom(off.trace('out'), 80);
    // The undertow tint is blue — the "on" frame should carry more blue-dominant
    // pixels than the "off" frame (which is portrait-colored).
    const blueish = (c: { r: number; g: number; b: number }) =>
      c.b > 80 && c.b > c.r + 20 && c.b > c.g + 10;
    expect(on.trace('out').countPixels(blueish))
      .toBeGreaterThan(off.trace('out').countPixels(blueish) + 20);
  });

  // Pull glues particles onto the limit cycle → they crowd there, giving the
  // interactions something to act on.
  const CROWD = {
    count: 4000, mode: 0, pull: 1.0, speed: 3.0, shape_kind: 1, size: 0.8,
    color_blend: 0.0, input_alpha: 0.0, blend_mode: 0, opacity: 1.0, seed: 2,
    interactions: true, interaction_radius: 0.03,
  };

  const runChain = (id: string, swarm: Record<string, unknown>, frames: number) =>
    runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: id, sketch: buildChain(true, swarm) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ]},
      ],
      waitFrames: frames, captureTraceIds: ['out'], dumpName: id,
    });

  it('avoid_noise scatters particles where avoidance goes flat', async () => {
    // avoid_noise lives inside the avoidance mechanism, so it needs avoid on.
    // It adds a random kick that breaks up flat-gradient clumps.
    const base = { ...CROWD, avoid: 1.0 };
    const off = await runChain('fs_noise_off', { ...base, avoid_noise: 0.0 }, 24);
    const on  = await runChain('fs_noise_on',  { ...base, avoid_noise: 0.6 }, 24);
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    expect(on.trace('out').countPixels(isActive)).toBeGreaterThan(80);
    on.trace('out').expectDifferentFrom(off.trace('out'), 40);
  });

  it('debug view renders the density buffer and reflects interaction_radius', async () => {
    // With the density buffer actually accumulating, the heat map is non-empty
    // and a bigger interaction_radius spreads/sums the halos → more coverage.
    // (This is the regression guard for the additive-blend alpha fix: a broken
    // splat leaves an empty buffer, so radius would have no effect.)
    const base = { ...CROWD, debug_density: true };
    const small = await runChain('fs_dbg_small', { ...base, interaction_radius: 0.008 }, 20);
    const large = await runChain('fs_dbg_large', { ...base, interaction_radius: 0.06 }, 20);
    expect(small.success).toBe(true);
    expect(large.success).toBe(true);
    const smallActive = small.trace('out').countPixels(isActive);
    const largeActive = large.trace('out').countPixels(isActive);
    expect(largeActive).toBeGreaterThan(200);
    expect(largeActive).toBeGreaterThan(smallActive + 100);
  });

  it('density death thins crowded regions (interactions)', async () => {
    // Same crowding setup; death culls particles where the density buffer says
    // it's crowded (they respawn elsewhere) → the frame changes vs death off.
    const off = await runChain('fs_death_off', { ...CROWD, density_death: 0.0 }, 28);
    const on  = await runChain('fs_death_on',
      { ...CROWD, density_death: 1.0, density_threshold: 1.0 }, 28);
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    expect(on.trace('out').countPixels(isActive)).toBeGreaterThan(80);
    on.trace('out').expectDifferentFrom(off.trace('out'), 40);
  });

  it('avoid/curl pushes particles apart (interactions)', async () => {
    // Avoidance reads the density gradient and pushes particles down it (curl
    // swirls the push) → the swarm spreads, changing the frame vs avoid off.
    const off = await runChain('fs_avoid_off', { ...CROWD, avoid: 0.0 }, 28);
    const on  = await runChain('fs_avoid_on', { ...CROWD, avoid: 1.0, avoid_curl: 0.5 }, 28);
    expect(off.success).toBe(true);
    expect(on.success).toBe(true);
    expect(on.trace('out').countPixels(isActive)).toBeGreaterThan(80);
    on.trace('out').expectDifferentFrom(off.trace('out'), 40);
  });
});
