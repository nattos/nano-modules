import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for video.local_delay (nano bundle) — the stylized
 * motion-driven local delay.
 *
 * Three things under test:
 *  1. No-motion identity: a static input has no flow → zero weight →
 *     the cross-fade collapses to the current frame (pass-through). This
 *     also smoke-tests that all four compute passes dispatch cleanly.
 *  2. delay_amount drives the cross-fade: with a MOVING input (a
 *     debug.motion_rect overlay), a high delay_amount ghosts moving
 *     edges toward the previous frame; delay_amount=0 does not. The two
 *     frames must differ.
 *  3. Motion producer: local_delay writes modulated vectors on
 *     render_outputs/motion. Wiring that rail into a downstream
 *     video.motion_blur changes the output vs. leaving it unwired —
 *     confirming the motion texture is actually published + transported.
 */

const RENDER_OUTPUTS_SCHEMA = {
  type: 'object',
  fields: {
    depth:  { type: 'texture' },
    motion: { type: 'texture' },
  },
};

describe('video.local_delay E2E', () => {
  jest.setTimeout(40000);

  it('passes a static input straight through (no motion → zero weight)', async () => {
    const sketch: Sketch = {
      anchor: null,
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'in' },
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.3, 0.5, 0.8] },
          },
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            // Crank delay + gain: even so, a static input has zero flow,
            // so the weight is zero and the output equals the input.
            params: { delay_amount: 1.0, weight_gain: 0.06 },
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
    };

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_static', sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_static' } },
        ]},
      ],
      waitFrames: 10,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_static',
    });
    expect(result.success).toBe(true);

    // solid_color (0.3, 0.5, 0.8) → (77, 128, 204). local_delay is a
    // pure pass-through when nothing moves.
    result.trace('out').expectUniformColor({ r: 77, g: 128, b: 204 }, 6);
  });

  it('ghosts moving edges in proportion to delay_amount', async () => {
    // A swarm of moving blobs over a solid bg gives local_delay real
    // frame-to-frame motion at many edges (a single hard rect would only
    // move flow on its 1-2px border). delay_amount=0 is identity
    // (weight ×0); delay_amount high blends those edges toward the
    // previous frame, so the two frames differ across a wide band.
    const buildChain = (delay: number): Sketch => ({
      anchor: null,
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'in' },
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.1, 0.1, 0.1] },
          },
          {
            type: 'module',
            module_type: 'debug.motion_swarm',
            instance_key: 'swarm@0',
            // Many moving blobs — used purely as moving IMAGE content (no
            // rail tap), so local_delay must estimate the flow itself.
            params: {
              count: 24, size: 0.06, swirl: 1.5, radial: 0.0,
              randomness: 0.4, speed: 1.0, opacity: 1.0, seed: 7,
            },
          },
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            params: {
              delay_amount: delay,
              weight_gain: 0.05,
              max_flow: 0.05,
              align_amount: 0.5,
            },
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
    });

    const noDelay = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_off', sketch: buildChain(0.0) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_off' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_off',
    });
    expect(noDelay.success).toBe(true);

    const withDelay = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_on', sketch: buildChain(0.9) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_on' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_on',
    });
    expect(withDelay.success).toBe(true);

    // Same moving chain, only delay_amount differs. The cross-fade toward
    // history must change a meaningful band of pixels around the swarm's
    // swept edges.
    withDelay.trace('out').expectDifferentFrom(noDelay.trace('out'), 100);
  });

  it('publishes modulated motion that drives a downstream motion_blur', async () => {
    const buildChain = (withRails: boolean): Sketch => ({
      anchor: null,
      columns: [{
        name: 'main',
        rails: withRails ? [{
          id: 'render_outputs_rail',
          name: 'Render Outputs',
          dataType: { kind: 'struct', schema: RENDER_OUTPUTS_SCHEMA },
        }] : [],
        chain: [
          { type: 'texture_input', id: 'in' },
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.05, 0.05, 0.05] },
          },
          {
            type: 'module',
            module_type: 'debug.motion_rect',
            instance_key: 'rect@0',
            params: { size: 0.3, speed: 3.0, color: [1.0, 0.4, 0.8] },
          },
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            params: { delay_amount: 0.5, weight_gain: 0.05, max_flow: 0.05 },
            taps: withRails
              ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'write' }]
              : [],
          },
          {
            type: 'module',
            module_type: 'video.motion_blur',
            instance_key: 'blur@0',
            params: { strength: 24.0, samples: 12, quality: 1 },
            taps: withRails
              ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'read' }]
              : [],
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
    });

    const withRails = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_rail', sketch: buildChain(true) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_rail' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_motion_rail',
    });
    expect(withRails.success).toBe(true);

    const withoutRails = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_norail', sketch: buildChain(false) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_norail' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_motion_norail',
    });
    expect(withoutRails.success).toBe(true);

    // The chains are identical except for the render_outputs rail. With
    // it wired, motion_blur reads local_delay's modulated vectors and
    // smears along them; without it, the blur falls back to a copy. The
    // frames must differ — proof the motion texture was published and
    // transported across the rail.
    withRails.trace('out').expectDifferentFrom(withoutRails.trace('out'), 40);
  });

  it('delay_steps changes the advection trail length', async () => {
    // Same moving chain advected 1 step vs many. More steps walk further along
    // the flow streamline before sampling the input, so the trail lands the
    // content in a different place — the frames must differ. Exercises the
    // forward-advection loop.
    const buildChain = (steps: number): Sketch => ({
      anchor: null,
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'in' },
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.1, 0.1, 0.1] },
          },
          {
            type: 'module',
            module_type: 'debug.motion_swarm',
            instance_key: 'swarm@0',
            params: {
              count: 24, size: 0.06, swirl: 1.5, radial: 0.0,
              randomness: 0.4, speed: 1.0, opacity: 1.0, seed: 7,
            },
          },
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            params: {
              delay_amount: 0.8, delay_steps: steps,
              weight_gain: 0.05, max_flow: 0.05,
            },
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
    });

    const fewSteps = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_s1', sketch: buildChain(1.0) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_s1' } },
        ]},
      ],
      waitFrames: 24,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_steps1',
    });
    expect(fewSteps.success).toBe(true);

    const manySteps = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_s16', sketch: buildChain(16.0) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_s16' } },
        ]},
      ],
      waitFrames: 24,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_steps16',
    });
    expect(manySteps.success).toBe(true);

    manySteps.trace('out').expectDifferentFrom(fewSteps.trace('out'), 40);
  });

  it('delay_amount=0 is an exact image passthrough (flow-conditioner mode)', async () => {
    // At delay_amount=0 the advection scale is 0, so the color pass early-outs
    // to a straight copy of the input — the image passes through untouched while
    // align/mask/motion still run (flow-conditioner mode). We trace local_delay's
    // OWN input and output in the SAME render (chain_entry input vs output) and
    // assert they're byte-identical. Tracing both sides of one stage avoids any
    // cross-sketch swarm-simulation divergence — the only thing under test is
    // that this stage leaves its input pixels untouched.
    const sketch: Sketch = {
      anchor: null,
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'in' },                                    // chainIdx 0
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.1, 0.1, 0.1] },
          },                                                                       // chainIdx 1
          {
            type: 'module',
            module_type: 'debug.motion_swarm',
            instance_key: 'swarm@0',
            params: {
              count: 24, size: 0.06, swirl: 1.5, radial: 0.0,
              randomness: 0.4, speed: 1.0, opacity: 1.0, seed: 7,
            },
          },                                                                       // chainIdx 2
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            params: { delay_amount: 0.0, weight_gain: 0.05, max_flow: 0.05 },
          },                                                                       // chainIdx 3
          { type: 'texture_output', id: 'out' },                                   // chainIdx 4
        ],
      }],
    };

    const result = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_pass', sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'ld_in',  target: { type: 'chain_entry', sketchId: 'ld_pass', colIdx: 0, chainIdx: 3, side: 'input'  } },
          { id: 'ld_out', target: { type: 'chain_entry', sketchId: 'ld_pass', colIdx: 0, chainIdx: 3, side: 'output' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['ld_in', 'ld_out'],
      dumpName: 'local_delay_passthrough',
    });
    expect(result.success).toBe(true);

    // Sanity: the input actually has moving content (not a flat frame), so the
    // passthrough assertion is meaningful.
    result.trace('ld_in').expectNotSolidColor({ r: 26, g: 26, b: 26 });
    // delay_amount=0 → output pixels equal input pixels exactly.
    result.trace('ld_out').expectSameAs(result.trace('ld_in'));
  });

  it('noise motion advances the stochastic seed (re-rolls under state replay)', async () => {
    // The noise mask gates the echo. With `motion`=0 the seed is fixed; with
    // `motion`>0 it must advance over time and re-roll the noise. Same moving
    // input + same frame count, so the ONLY difference is the seed advancing —
    // which it won't if the per-frame state replay keeps resetting the
    // accumulator (the bug). The two outputs must differ.
    const buildChain = (motion: number): Sketch => ({
      anchor: null,
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'in' },
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.1, 0.1, 0.1] },
          },
          {
            type: 'module',
            module_type: 'debug.motion_swarm',
            instance_key: 'swarm@0',
            params: {
              count: 24, size: 0.06, swirl: 1.5, radial: 0.0,
              randomness: 0.4, speed: 1.0, opacity: 1.0, seed: 7,
            },
          },
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            params: {
              delay_amount: 0.8, delay_steps: 12.0,
              noise_weight: 1.0, noise_motion: motion, weight_gain: 0.05, max_flow: 0.05,
            },
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
    });

    const frozen = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_nm0', sketch: buildChain(0.0) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_nm0' } },
        ]},
      ],
      waitFrames: 24,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_noise_frozen',
    });
    expect(frozen.success).toBe(true);

    const moving = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_nm1', sketch: buildChain(0.9) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'ld_nm1' } },
        ]},
      ],
      waitFrames: 24,
      captureTraceIds: ['out'],
      dumpName: 'local_delay_noise_moving',
    });
    expect(moving.success).toBe(true);

    moving.trace('out').expectDifferentFrom(frozen.trace('out'), 40);
  });

  it('uses incoming render_outputs motion as the flow when flow_source=Incoming', async () => {
    // A moving swarm publishes render_outputs/motion. With flow_source=Incoming
    // and the rail wired, local_delay echoes the input along THOSE vectors
    // (skipping its own estimator). Without the rail there's no upstream motion
    // → passthrough.
    //
    // We trace local_delay's OWN input and output in the SAME render (chain_entry
    // input vs output, chainIdx 3) rather than comparing two separate captures:
    // the swarm sim phase diverges run-to-run, so a cross-capture diff is
    // dominated by random swarm-position differences, not the echo. Within one
    // render the echo footprint is isolated. The path is proven by the contrast:
    // rail wired → output differs from input (incoming vectors drove the echo);
    // no rail → output equals input (zero incoming flow → passthrough).
    const buildChain = (withRail: boolean): Sketch => ({
      anchor: null,
      columns: [{
        name: 'main',
        rails: withRail ? [{
          id: 'render_outputs_rail',
          name: 'Render Outputs',
          dataType: { kind: 'struct', schema: RENDER_OUTPUTS_SCHEMA },
        }] : [],
        chain: [
          { type: 'texture_input', id: 'in' },
          {
            type: 'module',
            module_type: 'generator.solid_color',
            instance_key: 'bg@0',
            params: { color: [0.05, 0.05, 0.1] },
          },
          {
            type: 'module',
            module_type: 'debug.motion_swarm',
            instance_key: 'swarm@0',
            params: {
              count: 24, size: 0.08, swirl: 1.5, radial: 0.0,
              randomness: 0.4, speed: 2.5, opacity: 1.0, seed: 7,
            },
            taps: withRail
              ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'write' }]
              : [],
          },
          {
            type: 'module',
            module_type: 'video.local_delay',
            instance_key: 'ld@0',
            // Crank sensitivity/reach so the incoming-driven echo is well clear
            // of the passthrough baseline. smoothing=0 disables the temporal flow
            // EMA: the incoming swarm motion is sparse (nonzero only inside the
            // small moving rects) and intermittent at any fixed pixel, so the
            // default EMA would average it toward zero — unlike the dense LK flow
            // in Estimate mode. With no smoothing the per-frame vectors drive the
            // advection directly.
            params: { flow_source: 1, smoothing: 0.0, delay_amount: 1.0, delay_steps: 32.0, weight_gain: 0.15 },
            // Read tap fieldPath = the consumer's OWN input field name
            // ("render_outputs_in"), which is where Incoming mode reads the flow
            // (textureForField("render_outputs_in/motion")). The rail bridges the
            // swarm's "render_outputs" writer to this by railId, not fieldPath.
            taps: withRail
              ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs_in', direction: 'read' }]
              : [],
          },
          { type: 'texture_output', id: 'out' },
        ],
      }],
    });

    const withRail = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_inc_on', sketch: buildChain(true) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'ld_in',  target: { type: 'chain_entry', sketchId: 'ld_inc_on', colIdx: 0, chainIdx: 3, side: 'input'  } },
          { id: 'ld_out', target: { type: 'chain_entry', sketchId: 'ld_inc_on', colIdx: 0, chainIdx: 3, side: 'output' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['ld_in', 'ld_out'],
      dumpName: 'local_delay_incoming_on',
    });
    expect(withRail.success).toBe(true);

    const noRail = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'ld_inc_off', sketch: buildChain(false) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'ld_in',  target: { type: 'chain_entry', sketchId: 'ld_inc_off', colIdx: 0, chainIdx: 3, side: 'input'  } },
          { id: 'ld_out', target: { type: 'chain_entry', sketchId: 'ld_inc_off', colIdx: 0, chainIdx: 3, side: 'output' } },
        ]},
      ],
      waitFrames: 20,
      captureTraceIds: ['ld_in', 'ld_out'],
      dumpName: 'local_delay_incoming_off',
    });
    expect(noRail.success).toBe(true);

    // Rail wired: the incoming swarm vectors drive a forward-advection echo, so
    // local_delay's output departs from its input. The footprint is edge-limited
    // (only pixels inside the moving rects advect, and a solid blob mostly
    // samples its own color — only blob edges shift), but stable run-to-run
    // (~45 px); 25 sits safely below that floor and far above the passthrough's
    // 0, cleanly separating "incoming echo present" from "no echo".
    withRail.trace('ld_out').expectDifferentFrom(withRail.trace('ld_in'), 25);
    // No rail: zero incoming flow → the advection collapses → exact passthrough.
    noRail.trace('ld_out').expectSameAs(noRail.trace('ld_in'));
  });
});
