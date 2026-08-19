import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E: texture wires whose endpoints sit inside would-be-fused runs, and wires
 * out of DISABLED effects. The executor fuses consecutive per-pixel mappers
 * into one kernel; only the group edges have real textures. A texture wire
 * needs a real texture at its endpoint, so the planner must break fusion
 * there — and a disabled effect must still forward its passthrough (bypassed)
 * image onto its main output wire.
 *
 * All module types here (solid_color, invert) are fusion mappers, so without
 * the wire the whole chain fuses. Colors are exact (solid + invert are
 * bit-precise), tolerances kept small.
 */
describe('Texture wires × fusion × enable (E2E)', () => {
  jest.setTimeout(60000);

  // color.invert lives in the core bundle; solid_color/blend resolve from
  // testonly via the legacy map. Load core explicitly so invert is real.
  const MODULES = ['com.nano.core', 'source.solid_color', 'composite.blend'];

  it('wire OUT of a mid-run mapper feeds a downstream consumer', async () => {
    // red → invert (cyan) → invert (red) → blend. Wire taps the FIRST invert's
    // output (cyan) into blend's input B; opacity 1 → output = B = cyan.
    // If the mid-run texture is not materialised, B is unbound → not cyan.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@0', params: {} },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@1', params: {} },
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
          params: { opacity: 1.0 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'inv@0', field: 'tex_out' },
          dest: { instanceKey: 'blend@0', field: '1' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: 'ftw_out', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'ftw_out' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'ftw_wire_out_of_run',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 0, g: 255, b: 255 }, 6);
  });

  it('wire INTO a mid-run mapper overrides its chain input', async () => {
    // red → invert → invert, with a wire feeding the ORIGINAL red into the
    // second invert's tex_in. Without the wire the output is red (double
    // invert); with it the second invert inverts red → cyan.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@0', params: {} },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@1', params: {} },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'red@0', field: 'tex_out' },
          dest: { instanceKey: 'inv@1', field: 'tex_in' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: 'ftw_in', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'ftw_in' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'ftw_wire_into_run',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 0, g: 255, b: 255 }, 6);
  });

  it('a wire added to a RUNNING fused chain takes effect (live edit)', async () => {
    // Phase 1: the chain runs WITHOUT the wire and fully fuses.
    // Phase 2: updateSketch adds the tap wire — the plan must rebuild, break
    // the fusion at the tapped stage, and the wire must carry pixels.
    const base: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@0', params: {} },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@1', params: {} },
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
          params: { opacity: 1.0 } },
      ],
      wires: [],
    } as Sketch;
    const wired: Sketch = {
      ...base,
      wires: [
        { id: 'w0', src: { instanceKey: 'inv@0', field: 'tex_out' },
          dest: { instanceKey: 'blend@0', field: '1' } },
      ],
    } as Sketch;

    const result = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'ftw_live', sketch: base },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'ftw_live' } },
            ]},
          ],
          waitFrames: 20,
          captureTraceIds: ['out'],
        },
        {
          commands: [{ type: 'updateSketch', sketchId: 'ftw_live', sketch: wired }],
          waitFrames: 20,
          captureTraceIds: ['out'],
        },
      ],
      dumpName: 'ftw_live_edit',
    });
    expect(result.success).toBe(true);
    // Phase 1 (no wire): blend's B is unbound → transparent output (renders as
    // the checkerboard backdrop) — anything but cyan. The real assertion is
    // phase 2: the live-added wire must carry B = first invert's output → cyan.
    const p0 = result.phases[0].trace('out').pixelAt(32, 32);
    expect(Math.abs(p0.r - 0) + Math.abs(p0.g - 255) + Math.abs(p0.b - 255))
      .toBeGreaterThan(30);
    result.phases[1].trace('out').expectPixelAt(32, 32, { r: 0, g: 255, b: 255 }, 6);
  });

  it('wire from a DISABLED effect forwards its bypassed (passthrough) image', async () => {
    // red → inv@0 (DISABLED → passthrough red) → inv@1 (cyan) → blend.
    // The wire taps the disabled inv@0's tex_out into blend's B; a bypassed
    // effect's output IS its input, so B must carry red — not go dormant.
    const sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@0', params: {} },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@1', params: {} },
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
          params: { opacity: 1.0 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'inv@0', field: 'tex_out' },
          dest: { instanceKey: 'blend@0', field: '1' } },
      ],
      instances: {
        'inv@0': { module_type: 'color.invert', state: { __enable__: false } },
      },
    } as unknown as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: 'ftw_disabled', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'ftw_disabled' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'ftw_disabled_src',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 6);
  });

  it('routes the image through a SIDECAR-CANVAS node and back', async () => {
    // Same computation as red → invert → invert (= red), except the first
    // invert lives on the canvas and is reached only by texture wires. The
    // merged execution order interleaves it between the two linear entries.
    // If a canvas stage took the linear texture cursor instead of its wired
    // input — or published back onto it — this would not come out red.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@1', params: {} },
        { type: 'module', module_type: 'color.invert', instance_key: 'cv@0', params: {},
          canvas: { x: 40, y: 40 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'red@0', field: 'tex_out' },
          dest: { instanceKey: 'cv@0', field: 'tex_in' } },
        { id: 'w1', src: { instanceKey: 'cv@0', field: 'tex_out' },
          dest: { instanceKey: 'inv@1', field: 'tex_in' } },
      ],
      execOrder: ['red@0', 'cv@0', 'inv@1'],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: 'ftw_canvas', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'ftw_canvas' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'ftw_canvas_branch',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 6);
  });

  it('leaves the image untouched by an UNWIRED canvas node', async () => {
    // The cursor-isolation contract: a canvas node renders (its input is the
    // sketch input) but is off the image chain, so the output is exactly what
    // the linear list produced — red, not the canvas node's inverted frame.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'color.invert', instance_key: 'cv@0', params: {},
          canvas: { x: 10, y: 10 } },
      ],
      // Ordered LAST, where a stage that published to the cursor would win.
      execOrder: ['red@0', 'cv@0'],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: 'ftw_iso', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'ftw_iso' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'ftw_canvas_isolated',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 6);
  });
});
