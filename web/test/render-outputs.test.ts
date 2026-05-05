import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for the canonical RenderOutputs struct rail. Verifies
 * the writer-side texture publication (`state::setGpuTexture` →
 * `materializeStructSnapshot`) and the reader-side hoist
 * (`applyStructRead` → `gpu::Device::textureForField`) are wired
 * end-to-end for an OPTIONAL texture leaf.
 *
 * Producer:  `debug.motion_rect` — overlays a moving colored rect and
 *            writes per-pixel velocity into `render_outputs/motion`.
 * Consumer:  `video.motion_blur` — reads `render_outputs/motion` and
 *            samples `tex_in` along the velocity to produce a directional
 *            blur. Pass-through when no upstream produces motion.
 */

const RENDER_OUTPUTS_SCHEMA = {
  type: 'object',
  fields: {
    depth:  { type: 'texture' },
    motion: { type: 'texture' },
  },
};

function buildChain(opts: { withMotionRect: boolean; withRails: boolean }): Sketch {
  const chain: any[] = [
    { type: 'texture_input', id: 'in' },
    {
      type: 'module',
      module_type: 'generator.solid_color',
      instance_key: 'bg@0',
      params: { color: [0.2, 0.2, 0.2] },
    },
  ];
  if (opts.withMotionRect) {
    chain.push({
      type: 'module',
      module_type: 'debug.motion_rect',
      instance_key: 'rect@0',
      params: { size: 0.3, speed: 1.0, color: [1.0, 0.4, 0.8] },
      taps: opts.withRails
        ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'write' }]
        : [],
    });
  }
  chain.push({
    type: 'module',
    module_type: 'video.motion_blur',
    instance_key: 'blur@0',
    params: { strength: 2.0, samples: 12 },
    taps: opts.withRails
      ? [{ railId: 'render_outputs_rail', fieldPath: 'render_outputs', direction: 'read' }]
      : [],
  });
  chain.push({ type: 'texture_output', id: 'out' });
  return {
    anchor: null,
    columns: [{
      name: 'main',
      rails: opts.withRails ? [{
        id: 'render_outputs_rail',
        name: 'Render Outputs',
        dataType: { kind: 'struct', schema: RENDER_OUTPUTS_SCHEMA },
      }] : [],
      chain,
    }],
  };
}

describe('RenderOutputs struct rail (motion blur showcase) E2E', () => {
  jest.setTimeout(40000);

  it('auto-routes motion vectors when the canonical rail is wired', async () => {
    const withRails = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_with_rails',
          sketch: buildChain({ withMotionRect: true, withRails: true }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_with_rails' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_with_rails',
    });
    expect(withRails.success).toBe(true);

    const withoutRails = await runEngineTest({
      width: 128, height: 128,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_without_rails',
          sketch: buildChain({ withMotionRect: true, withRails: false }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_without_rails' } },
        ]},
      ],
      waitFrames: 30,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_without_rails',
    });
    expect(withoutRails.success).toBe(true);

    // The two sketches differ ONLY in whether the canonical rail is wired
    // — same modules, same params, same tick count. With rails, the blur
    // applies a sample-along-velocity kernel that mixes rect pixels with
    // their neighbours; without rails, motion_blur falls back to a copy
    // and the rect comes through sharp. The frames must be visibly
    // different to confirm the rail actually transported the motion
    // texture handle.
    withRails.trace('out').expectDifferentFrom(withoutRails.trace('out'), 50);
  });

  it('falls back to pass-through when no upstream produces motion', async () => {
    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nattos.testonly'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'mb_passthru',
          sketch: buildChain({ withMotionRect: false, withRails: false }),
        },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'mb_passthru' } },
        ]},
      ],
      waitFrames: 15,
      captureTraceIds: ['out'],
      dumpName: 'render_outputs_passthru',
    });
    expect(result.success).toBe(true);

    // solid_color with color=(0.2, 0.2, 0.2) → (51, 51, 51, 255). With
    // no motion producer, motion_blur copies tex_in to tex_out → output
    // matches solid_color's output pixel-for-pixel.
    result.trace('out').expectUniformColor({ r: 51, g: 51, b: 51, a: 255 }, 5);
  });
});
