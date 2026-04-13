import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E: particles_emitter → particles_renderer connected by a struct rail
 * carrying GPU-resident position/velocity arrays plus a scalar count.
 *
 * The emitter publishes per-frame particle data into a GPU storage buffer;
 * the renderer instances one quad per particle, reading positions[iid]
 * directly from that buffer in its vertex shader.
 */

const PARTICLES_STRUCT_SCHEMA = {
  type: 'object',
  fields: {
    count: { type: 'int' },
    positions:  { type: 'array', gpu: true, elementType: { type: 'float' } },
    velocities: { type: 'array', gpu: true, elementType: { type: 'float' } },
  },
};

function buildParticleSketch(opts: {
  particleSize?: number;
  tint?: [number, number, number, number];
  gravity?: [number, number];
} = {}): Sketch {
  const tint = opts.tint ?? [1.0, 0.7, 0.2, 1.0];
  const size = opts.particleSize ?? 0.04;
  const gravity = opts.gravity ?? [0.0, -0.4];
  return {
    anchor: null,
    columns: [{
      name: 'main',
      rails: [
        {
          id: 'particles_rail',
          name: 'Particle Data',
          dataType: { kind: 'struct', schema: PARTICLES_STRUCT_SCHEMA },
        },
      ],
      chain: [
        { type: 'texture_input', id: 'in' },
        {
          type: 'module',
          module_type: 'com.nattos.nano_effects.data.particles_emitter',
          instance_key: 'emit@0',
          // Initial state: feed gravity (vec2) and spawn_speed.
          params: { spawn_speed: 0.6, gravity },
          taps: [
            { railId: 'particles_rail', fieldPath: 'particles_out', direction: 'write' },
          ],
        },
        {
          type: 'module',
          module_type: 'com.nattos.nano_effects.video.particles_renderer',
          instance_key: 'render@0',
          params: { particle_size: size, tint },
          taps: [
            { railId: 'particles_rail', fieldPath: 'particles_in', direction: 'read' },
          ],
        },
        { type: 'texture_output', id: 'out' },
      ],
    }],
  };
}

describe('Particles (struct rail + GPU array) E2E', () => {
  jest.setTimeout(40000);

  it('renders particles from emitter into renderer output', async () => {
    const result = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.nano_effects'],
      commands: [
        { type: 'createSketch', sketchId: 'particles_sketch', sketch: buildParticleSketch() },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'particles_sketch' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'particles_basic',
    });

    expect(result.success).toBe(true);
    const frame = result.trace('out');

    // Background is dark blue-ish (cleared by renderer to ~0.02,0.02,0.04).
    // Particles are tinted (1.0, 0.7, 0.2, 1.0) → ~(255, 178, 51).
    // We expect at least *some* tinted pixels in the frame.
    const isParticle = (c: { r: number; g: number; b: number }) =>
      c.r > 120 && c.g > 60 && c.g < 220 && c.b < 120;
    frame.expectCoverage(isParticle, { min: 0.005 });
    // And the frame must not be solid background.
    frame.expectNotSolidColor({ r: 5, g: 5, b: 10 }, /*tolerance*/ 12);
  });

  it('particle motion produces a different frame after more ticks', async () => {
    const result = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nattos.nano_effects'],
      dumpName: 'particles_motion',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'particles_motion', sketch: buildParticleSketch() },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'particles_motion' } },
            ]},
          ],
          waitFrames: 3,
          captureTraceIds: ['out'],
        },
        {
          commands: [],
          waitFrames: 120,
          captureTraceIds: ['out'],
        },
      ],
    });

    expect(result.success).toBe(true);
    const early = result.phases[0].trace('out');
    const late  = result.phases[1].trace('out');

    // Motion should produce a meaningfully different frame.
    late.expectDifferentFrom(early, /*minDiffPixels*/ 80);
  });

  it('respects renderer tint (vec4) param', async () => {
    const result = await runEngineTest({
      width: 96, height: 96,
      modules: ['com.nattos.nano_effects'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'particles_tint',
          sketch: buildParticleSketch({ tint: [0.1, 0.9, 1.0, 1.0], particleSize: 0.06 }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'particles_tint' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'particles_cyan_tint',
    });

    expect(result.success).toBe(true);
    const frame = result.trace('out');

    // Cyan-ish particles: high G + high B, low R.
    const isCyan = (c: { r: number; g: number; b: number }) =>
      c.b > 150 && c.g > 150 && c.r < 120;
    frame.expectCoverage(isCyan, { min: 0.005 });
  });
});
