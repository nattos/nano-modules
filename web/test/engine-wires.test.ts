import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the single-stack WIRE model (replacing taps+rails). Wires connect a
 * producer output field to a consumer input field, addressed by instance_key;
 * causality is positional (producer above → same-frame). This file covers the
 * explicit-wire path; auto-connect + dashboard land with their migrations.
 */
describe('Wire routing E2E', () => {
  jest.setTimeout(30000);

  it('texture fan-out + combine in ONE column via explicit wires', async () => {
    // Single column: red, blue, blend. No rails/taps. Wires fan the two solids
    // into blend's two texture inputs (0,1); both producers are above blend, so
    // the values are read same-frame. 50% blend of red+blue → purple.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
        params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'source.solid_color', instance_key: 'blue@0',
        params: { color: [0.0, 0.0, 1.0] } },
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
        params: { opacity: 0.5 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'red@0',  field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '0' } },
        { id: 'w1', src: { instanceKey: 'blue@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '1' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'composite.blend'],
      commands: [{ type: 'createSketch', sketchId: 'wire_blend', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_blend' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_blend',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 0, b: 128 }, 15);
  });

  it('texture wires by schema field name reach positional inputs (tex_a/tex_b)', async () => {
    // The IDE addresses a texture input by its schema NAME (tex_a/tex_b), but
    // composite.blend reads inputTexture(0)/(1) positionally. A named texture wire
    // must therefore also feed the positional slot (index = order among input-
    // texture fields). Two solids above → blend; wired by name; opacity 0.5.
    // Without the name→index mapping the wires are ignored and the output is just
    // the implicit chain flow (the stage above) — here it'd show solid blue.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
        params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'source.solid_color', instance_key: 'blue@0',
        params: { color: [0.0, 0.0, 1.0] } },
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
        params: { opacity: 0.5 } },
      ],
      wires: [
        { id: 'wa', src: { instanceKey: 'red@0',  field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: 'tex_a' } },
        { id: 'wb', src: { instanceKey: 'blue@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: 'tex_b' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'composite.blend'],
      commands: [{ type: 'createSketch', sketchId: 'wire_named', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_named' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_named',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 0, b: 128 }, 15);
  });

  it('forward scalar wire from a passthrough modulation source', async () => {
    // mod.source.lfo declares NO output texture → it is a texture-passthrough
    // modulation source: tick runs and publishes its scalar `output`, but it
    // consumes no slot and leaves the image chain untouched. With rate=0 its
    // phase stays 0 → output == 0.5 (constant, deterministic).
    //
    // Chain: white solid → lfo (passthrough) → brightness_contrast. A wire feeds
    // lfo.output (0.5) into bc.brightness, OVERRIDING the stored brightness=1.0.
    //   src 0.5 folds into brightness's [-1,1] → 0 (neutral shift); contrast -0.5
    //   → scale 0.5; white(1) → 0.5 = gray.
    // The three outcomes are distinct, so gray(128) proves BOTH mechanics at once:
    //   • wire failed   → brightness stays 1.0 → (1+1)*0.5 = white(255)
    //   • passthrough broke (lfo overwrote the chain with its empty image)
    //                    → input black → (0+0)*0.5 = black(0)
    //   • both work      → gray(128)  ✓
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
        { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
          dest: { instanceKey: 'bc@0', field: 'brightness' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'mod.source.lfo', 'color.tone.brightness_contrast'],
      commands: [{ type: 'createSketch', sketchId: 'wire_lfo', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_lfo' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_lfo',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('delayed/backward texture wire = self-feedback accumulator', async () => {
    // A backward texture wire reads the producer's PREVIOUS-frame output. The
    // cleanest probe is a SELF-loop on the bottom (output) stage: acc@0.tex_out
    // → acc@0.'1' (src pos == dest pos → delayed). Chain top→bottom: src@0 (a dim
    // red, feeding acc's input A same-frame via the implicit texture flow), acc@0
    // (composite.blend, the output). With opacity 0.9:
    //     out = 0.1*src + 0.9*(acc's PREVIOUS out)
    // so the red channel ramps UP frame-over-frame toward src (≈102), converging
    // only because each frame folds in the last frame's result. A monotonic rise
    // proves the delayed wire is delivering frame N-1 (a broken/empty feedback
    // would pin the output at 0.1*src every frame instead).
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [0.4, 0.0, 0.0] } },
        { type: 'module', module_type: 'composite.blend', instance_key: 'acc@0',
        params: { opacity: 0.97 } },
      ],
      wires: [
        { id: 'fb', src: { instanceKey: 'acc@0', field: 'tex_out' },
          dest: { instanceKey: 'acc@0', field: '1' } },
      ],
    } as Sketch;

    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'composite.blend'],
      dumpName: 'wire_feedback',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'wire_fb', sketch },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'wire_fb' } },
            ]},
          ],
          waitFrames: 1, captureTraceIds: ['out'],
        },
        { waitFrames: 6, captureTraceIds: ['out'] },
        { waitFrames: 13, captureTraceIds: ['out'] },
      ],
    });

    expect(r.success).toBe(true);
    const r0 = r.phases[0].trace('out').pixelAt(32, 32).r;
    const r1 = r.phases[1].trace('out').pixelAt(32, 32).r;
    const r2 = r.phases[2].trace('out').pixelAt(32, 32).r;
    // Accumulating toward src (~102), bounded by it. Without a working delayed
    // wire the output would pin at the no-feedback floor (~0.03*src ≈ 3); a high
    // floor + monotonic rise + clear net gain proves frame N-1 is fed back.
    expect(r0).toBeGreaterThan(15);            // feedback present (>> ~3 floor)
    expect(r1).toBeGreaterThanOrEqual(r0);     // non-decreasing
    expect(r2).toBeGreaterThan(r1);            // still climbing at the end
    expect(r2).toBeGreaterThan(r0 + 10);       // clear net accumulation
    expect(r2).toBeLessThanOrEqual(110);       // never exceeds src
  });

  it('util.dashboard knob is both a wire sink and source', async () => {
    // The dashboard is a real schema-backed effect whose knob_i fields are both
    // inputs and outputs (the relay case). knob_0 is wired BOTH ways: lfo.output
    // (0.5) drives INTO it (overriding the stored 1.0), and it drives OUT to
    // brightness_contrast.brightness.
    //   white input, src 0.5 folds to brightness 0 (neutral); contrast -0.5 → scale 0.5 → gray.
    // gray(128) proves both directions: if the input wire failed the knob stays
    // 1.0 → white; if the output wire failed brightness stays its stored 1.0 →
    // white. Only knob=0.5 reaching brightness yields gray.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
        { type: 'module', module_type: 'util.dashboard', instance_key: 'dash@0' },
        { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
      ],
      instances: {
        'dash@0': { module_type: 'util.dashboard', state: { knob_0: 1.0 } },
      },
      wires: [
        { id: 'win',  src: { instanceKey: 'lfo@0',  field: 'output' },
          dest: { instanceKey: 'dash@0', field: 'knob_0' } },
        { id: 'wout', src: { instanceKey: 'dash@0', field: 'knob_0' },
          dest: { instanceKey: 'bc@0',   field: 'brightness' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      // Load the whole core bundle: util.dashboard (a real core effect) lives
      // there alongside solid_color / lfo / brightness_contrast.
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: 'wire_dash', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_dash' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_dash',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });
});
