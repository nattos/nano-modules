import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

// Per-effect tests for `video.blend` against the shipping `core` bundle.
// video.blend takes two texture inputs (tex_a, tex_b) and outputs
// `tex_a * (1 - opacity) + tex_b * opacity`. The runner can't feed two
// independent inputs through the chain ping-pong, so tests build a sketch with
// two solid_color sources WIRED into the blend's tex_a / tex_b inputs (named
// texture wires resolve to inputTexture(0/1) positionally).

function buildBlendSketch(opts: {
  sketchId: string;
  colorA: { r: number; g: number; b: number };
  colorB: { r: number; g: number; b: number };
  opacity: number;
}): Sketch {
  const a = `${opts.sketchId}_a`, b = `${opts.sketchId}_b`, blend = `${opts.sketchId}_blend`;
  return {
    anchor: null,
    wires: [
      { id: 'wa', src: { instanceKey: a, field: 'tex_out' }, dest: { instanceKey: blend, field: 'tex_a' } },
      { id: 'wb', src: { instanceKey: b, field: 'tex_out' }, dest: { instanceKey: blend, field: 'tex_b' } },
    ],
    chain: [
      {
        type: 'module',
        module_type: 'generator.solid_color',
        instance_key: a,
        params: { color: [opts.colorA.r, opts.colorA.g, opts.colorA.b] },
      },
      {
        type: 'module',
        module_type: 'generator.solid_color',
        instance_key: b,
        params: { color: [opts.colorB.r, opts.colorB.g, opts.colorB.b] },
      },
      {
        type: 'module',
        module_type: 'video.blend',
        instance_key: blend,
        params: { opacity: opts.opacity },
      },
    ],
  } as Sketch;
}

describe('Video Blend Effect E2E', () => {
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
    const blend = result.state?.plugins?.find((p: any) => p.id === 'video.blend');
    expect(blend).toBeDefined();
    expect(blend!.params.find((p: any) => p.name === 'opacity')).toBeDefined();
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
});
