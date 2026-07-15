import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

// Per-effect tests for `composite.blend` against the shipping `core` bundle.
// composite.blend takes two texture inputs (tex_a, tex_b) and outputs
// `tex_a * (1 - opacity) + tex_b * opacity`. The runner can't feed two
// independent inputs through the chain ping-pong, so tests build a sketch with
// two solid_color sources WIRED into the blend's tex_a / tex_b inputs (named
// texture wires resolve to inputTexture(0/1) positionally).

function buildBlendSketch(opts: {
  sketchId: string;
  colorA: { r: number; g: number; b: number };
  colorB: { r: number; g: number; b: number };
  opacity: number;
  mode?: number;
  shape?: number;
}): Sketch {
  const a = `${opts.sketchId}_a`, b = `${opts.sketchId}_b`, blend = `${opts.sketchId}_blend`;
  const params: Record<string, unknown> = { opacity: opts.opacity };
  if (opts.mode !== undefined) params.mode = opts.mode;
  if (opts.shape !== undefined) params.shape = opts.shape;
  return {
    anchor: null,
    wires: [
      { id: 'wa', src: { instanceKey: a, field: 'tex_out' }, dest: { instanceKey: blend, field: 'tex_a' } },
      { id: 'wb', src: { instanceKey: b, field: 'tex_out' }, dest: { instanceKey: blend, field: 'tex_b' } },
    ],
    chain: [
      {
        type: 'module',
        module_type: 'source.solid_color',
        instance_key: a,
        params: { color: [opts.colorA.r, opts.colorA.g, opts.colorA.b] },
      },
      {
        type: 'module',
        module_type: 'source.solid_color',
        instance_key: b,
        params: { color: [opts.colorB.r, opts.colorB.g, opts.colorB.b] },
      },
      {
        type: 'module',
        module_type: 'composite.blend',
        instance_key: blend,
        params,
      },
    ],
  } as Sketch;
}

describe('Blend Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    // Build a minimal sketch and verify the effect was registered correctly
    // by inspecting the plugin metadata reported through engineState.
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_meta',
          sketch: buildBlendSketch({
            sketchId: 'blend_meta',
            colorA: { r: 0.5, g: 0.5, b: 0.5 },
            colorB: { r: 0.5, g: 0.5, b: 0.5 },
            opacity: 0.5,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_meta' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_metadata',
    });

    expect(result.success).toBe(true);
    const blend = result.state?.plugins?.find((p: any) => p.id === 'composite.blend');
    expect(blend).toBeDefined();
    expect(blend!.params.find((p: any) => p.name === 'opacity')).toBeDefined();
    // Schema-level UI options (state::Schema step/description) reach the web schema.
    const opacity = (blend as any).schema?.opacity;
    expect(opacity?.step).toBeCloseTo(0.01, 5);
    expect(typeof opacity?.description).toBe('string');
    expect((blend as any).schema?.mode?.description).toContain('Photoshop');
  });

  it('opacity=0 passes texture A through unchanged', async () => {
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_a',
          sketch: buildBlendSketch({
            sketchId: 'blend_a',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 0.0,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_a' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_a_only',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectUniformColor({ r: 255, g: 0, b: 0, a: 255 }, 4);
  });

  it('opacity=1 passes texture B through unchanged', async () => {
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_b',
          sketch: buildBlendSketch({
            sketchId: 'blend_b',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 1.0,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_b' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_b_only',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectUniformColor({ r: 0, g: 0, b: 255, a: 255 }, 4);
  });

  it('opacity=0.5 produces an even mix', async () => {
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_half',
          sketch: buildBlendSketch({
            sketchId: 'blend_half',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 0.5,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_half' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_half',
    });

    expect(result.success).toBe(true);
    // 50% of red (255,0,0) and 50% of blue (0,0,255) → (~128, 0, ~128).
    result.trace('out').expectPixelAt(16, 16, { r: 128, g: 0, b: 128 }, 8);
  });

  it('blends three colour channels independently', async () => {
    // A = (1.0, 0.4, 0.0), B = (0.0, 0.0, 0.8), opacity = 0.25
    // Expected: (0.75 * 1.0 + 0.25 * 0.0, 0.75 * 0.4 + 0.25 * 0.0, 0.75 * 0.0 + 0.25 * 0.8)
    //        = (0.75, 0.30, 0.20) → (191, 76, 51)
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_mixed',
          sketch: buildBlendSketch({
            sketchId: 'blend_mixed',
            colorA: { r: 1.0, g: 0.4, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 0.8 },
            opacity: 0.25,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_mixed' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_mixed',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(16, 16, { r: 191, g: 76, b: 51 }, 6);
  });

  it('crossfade shape=1 at mid-fade shows B at full coverage (Normal)', async () => {
    // shape bends the fader→coverage curve (xfade_shape.h): at shape 1 the
    // trapezoid reaches full coverage by mid-fade, so opacity 0.5 shows pure B
    // instead of the linear half-mix. (shape 0 keeps the legacy ramp — covered
    // by the unchanged tests above.)
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_shape1',
          sketch: buildBlendSketch({
            sketchId: 'blend_shape1',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 0.5,
            shape: 1.0,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_shape1' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_shape1',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectUniformColor({ r: 0, g: 0, b: 255, a: 255 }, 4);
  });

  it('crossfade shape=0.5 at mid-fade is equal-power (~0.707 B coverage)', async () => {
    // wB(0.5, 0.5) = sin(π/4) ≈ 0.7071 → out = 0.7071·B + 0.2929·A
    //             = (0.2929, 0, 0.7071) → (75, 0, 180).
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_eqp',
          sketch: buildBlendSketch({
            sketchId: 'blend_eqp',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 0.5,
            shape: 0.5,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_eqp' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_eqp',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(16, 16, { r: 75, g: 0, b: 180 }, 8);
  });

  it('Add mode with shape=1 shows the full-strength blend at mid-fade', async () => {
    // Discriminating: at shape 0 the mid-fade Add is half-diluted with A
    // (out ≈ (255, 0, 128)); at shape 1 coverage is full → pure blended
    // red + blue = magenta.
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_add_shape',
          sketch: buildBlendSketch({
            sketchId: 'blend_add_shape',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 0.5,
            mode: 1, // Add
            shape: 1.0,
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_add_shape' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_add_shape',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectUniformColor({ r: 255, g: 0, b: 255, a: 255 }, 4);
  });

  it('per-effect layer crossfade honors __xfade_shape__ (executor wet/dry path)', async () => {
    // Not composite.blend: this exercises the EXECUTOR's WetDryBlend
    // (host_blend.h) via the reserved instance-state keys. A red generator
    // followed by a blue generator at __opacity__ 0.5: the legacy Normal
    // wet/dry is mix → (128, 0, 128); with __xfade_shape__ 1 the weighted
    // over at full alpha shows the (opaque) wet side → pure blue.
    const mkSketch = (id: string, shape?: number): Sketch => ({
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: `${id}_red`,
          params: { color: [1, 0, 0] } },
        { type: 'module', module_type: 'source.solid_color', instance_key: `${id}_blue`,
          params: { color: [0, 0, 1] } },
      ],
      instances: {
        [`${id}_blue`]: {
          module_type: 'source.solid_color',
          state: shape !== undefined
            ? { __opacity__: 0.5, __xfade_shape__: shape }
            : { __opacity__: 0.5 },
        },
      },
    } as unknown as Sketch);

    for (const [id, shape, expected] of [
      ['layer_lin', undefined, { r: 128, g: 0, b: 128 }],
      ['layer_trap', 1.0, { r: 0, g: 0, b: 255 }],
    ] as const) {
      const result = await runEngineTest({
        width: 32, height: 32,
        modules: ['com.nano.core'],
        commands: [
          { type: 'createSketch', sketchId: id, sketch: mkSketch(id, shape) },
        ],
        tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } },
        ],
        captureTraceIds: ['out'],
        waitFrames: 5,
        dumpName: id,
      });
      expect(result.success).toBe(true);
      result.trace('out').expectPixelAt(16, 16, expected, 8);
    }
  });

  it('Add mode (mode=1) sums the channels: red + blue = magenta', async () => {
    // Locks the shader-switch path through naga/WGSL on the web backend.
    // A = red (1,0,0), B = blue (0,0,1), opacity = 1, Add → (1,0,1) = magenta.
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        {
          type: 'createSketch',
          sketchId: 'blend_add',
          sketch: buildBlendSketch({
            sketchId: 'blend_add',
            colorA: { r: 1.0, g: 0.0, b: 0.0 },
            colorB: { r: 0.0, g: 0.0, b: 1.0 },
            opacity: 1.0,
            mode: 1, // Add
          }),
        },
      ],
      tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId: 'blend_add' } },
      ],
      captureTraceIds: ['out'],
      waitFrames: 5,
      dumpName: 'blend_add',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectUniformColor({ r: 255, g: 0, b: 255, a: 255 }, 4);
  });
});
