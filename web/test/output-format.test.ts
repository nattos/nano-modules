import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the per-sketch output-format override (Sketch.outputFormat) through
 * the REAL web engine (engine worker + executor.wasm + WebGPU host). Native
 * pixel math is covered by test_sketch_output_format.cpp; these lock the
 * WEB-specific format plumbing, where WebGPU validates what Metal tolerates:
 * per-format WGSL storage declarations (naga translation at rgba16float),
 * pipeline-layout format resolution, the fused kernel's baked output format,
 * the output blit's WGSL variant, and the bit-depth-change slot rebuild.
 * A format mismatch anywhere fails pipeline/bind validation → black output →
 * the pixel assertions here fail.
 */
describe('Per-sketch output format E2E', () => {
  jest.setTimeout(45000);

  const solid = (key: string, rgb: [number, number, number]) => ({
    type: 'module' as const, module_type: 'source.solid_color', instance_key: key,
    params: { color: rgb },
  });

  it('16F fused chain renders through rgba16float intermediates', async () => {
    // gray 0.25 → +0.25 → +0.25 ≈ 0.75. The two brightness stages fuse (the
    // production default), so this exercises composeWgsl's rgba16float output
    // declaration + the FusionDispatcher's format-keyed pipeline.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        solid('gray@0', [0.25, 0.25, 0.25]),
        { type: 'module', module_type: 'color.tone.brightness_contrast',
          instance_key: 'bcA@0', params: { brightness: 0.25, contrast: 0 } },
        { type: 'module', module_type: 'color.tone.brightness_contrast',
          instance_key: 'bcB@0', params: { brightness: 0.25, contrast: 0 } },
      ],
      wires: [],
      outputFormat: { bitDepth: 16 },
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'color.tone.brightness_contrast'],
      commands: [{ type: 'createSketch', sketchId: 'of_fused16f', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'of_fused16f' } }],
      captureTraceIds: ['out'],
      waitFrames: 25,
      dumpName: 'output_format_fused_16f',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 191, g: 191, b: 191 }, 10);
  });

  it('16F standalone multi-input effect (composite.blend) renders', async () => {
    // composite.blend is fusion-ineligible → a real standalone compute
    // dispatch writing a 16F tex_out through the sketch-default storage
    // binding (the effect-migration contract).
    const sketch: Sketch = {
      anchor: null,
      chain: [
        solid('red@0', [1, 0, 0]),
        solid('blue@0', [0, 0, 1]),
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
          params: { opacity: 0.5 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'red@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '0' } },
        { id: 'w1', src: { instanceKey: 'blue@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '1' } },
      ],
      outputFormat: { bitDepth: 16 },
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'composite.blend'],
      commands: [{ type: 'createSketch', sketchId: 'of_blend16f', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'of_blend16f' } }],
      captureTraceIds: ['out'],
      waitFrames: 25,
      dumpName: 'output_format_blend_16f',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 0, b: 128 }, 15);
  });

  it('half-res internal render still fills the full-size output', async () => {
    // 0.5x multiplier: the chain runs at 32x32 and the output blit stretches
    // into the 64x64 host output (WGSL rgba8unorm variant of OutputBlit). A
    // solid color survives the round trip exactly.
    const sketch: Sketch = {
      anchor: null,
      chain: [solid('red@0', [1, 0, 0])],
      wires: [],
      outputFormat: { resolution: { mode: 'multiplier', scale: 0.5 } },
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color'],
      commands: [{ type: 'createSketch', sketchId: 'of_halfres', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'of_halfres' } }],
      captureTraceIds: ['out'],
      waitFrames: 25,
      dumpName: 'output_format_halfres',
    });
    expect(result.success).toBe(true);
    const out = result.trace('out');
    expect(out.width).toBe(64);
    out.expectUniformColor({ r: 255, g: 0, b: 0 }, 10);
  });

  it('malformed outputFormat (null scale) renders instead of aborting the worker', async () => {
    // Regression: a NaN scale serializes to JSON null, which the native
    // value<double>() rejected → WASM `unreachable` aborted the whole engine
    // ([sketch default:source.shape_fold] RuntimeError: unreachable). This
    // bypasses the web sanitizer to drive the malformed JSON straight into
    // executor.wasm, which must now fall back to host size and keep rendering.
    const sketch = {
      anchor: null,
      chain: [solid('red@0', [1, 0, 0])],
      wires: [],
      outputFormat: { resolution: { mode: 'multiplier', scale: null } },
    } as unknown as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color'],
      commands: [{ type: 'createSketch', sketchId: 'of_badscale', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'of_badscale' } }],
      captureTraceIds: ['out'],
      waitFrames: 25,
      dumpName: 'output_format_badscale',
    });
    expect(result.success).toBe(true);
    const out = result.trace('out');
    expect(out.width).toBe(64);          // fell back to host size, no crash
    out.expectUniformColor({ r: 255, g: 0, b: 0 }, 10);
  });

  it('live bit-depth toggle rebuilds instances and keeps rendering', async () => {
    // 8-bit → 16F on the SAME sketch id: the executor mints fresh instances
    // under the format-suffixed namespace and the web slot rebuild retranslates
    // WGSL under the new default. Both phases must render the same image.
    const mk = (bitDepth?: 8 | 16): Sketch => ({
      anchor: null,
      chain: [
        solid('red@0', [1, 0, 0]),
        { type: 'module', module_type: 'color.tone.brightness_contrast',
          instance_key: 'bc@0', params: { brightness: 0, contrast: 0 } },
      ],
      wires: [],
      ...(bitDepth === 16 ? { outputFormat: { bitDepth: 16 as const } } : {}),
    } as Sketch);

    const result = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'color.tone.brightness_contrast'],
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'of_toggle', sketch: mk() },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'of_toggle' } }] },
          ],
          waitFrames: 25,
          captureTraceIds: ['out'],
        },
        {
          commands: [{ type: 'updateSketch', sketchId: 'of_toggle', sketch: mk(16) }],
          waitFrames: 30,   // instance rebuild = fresh WasmHost instantiation
          captureTraceIds: ['out'],
        },
      ],
      dumpName: 'output_format_toggle',
    });
    expect(result.success).toBe(true);
    result.phases[0].trace('out').expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 10);
    result.phases[1].trace('out').expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 10);
  });
});
