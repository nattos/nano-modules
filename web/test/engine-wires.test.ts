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
    // shape 0 pins the legacy linear crossfade (the default 0.5 is equal-power,
    // which weights the mid-fader ~0.71/0.71 — not the 50/50 mix asserted here).
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0',
        params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'source.solid_color', instance_key: 'blue@0',
        params: { color: [0.0, 0.0, 1.0] } },
        { type: 'module', module_type: 'composite.blend', instance_key: 'blend@0',
        params: { opacity: 0.5, shape: 0.0 } },
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
    // texture fields). Two solids above → blend; wired by name; opacity 0.5
    // (shape 0 = legacy linear crossfade, so the 50/50 purple stays exact).
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
        params: { opacity: 0.5, shape: 0.0 } },
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
    // (composite.blend, the output). With opacity 0.97 at shape 0 (the legacy
    // linear crossfade — the default 0.5 equal-power curve would change the
    // convergence constants) the premultiplied crossfade folds
    //     out = 0.03·src ⊕ 0.97·(acc's PREVIOUS out)
    // The straight COLOR is exactly src from frame 1; what accumulates is the
    // ALPHA: a_n = 1 − 0.97ⁿ (frame 0's feedback input is unbound ⇒
    // transparent). Traces composite onto the checkerboard backdrop, so the
    // probed red starts near the checker gray and DESCENDS frame-over-frame
    // toward src (0.4 → ≈102) as the alpha builds — a descent that only
    // happens if each frame folds in the last frame's result. Broken/empty
    // feedback pins the alpha at 0.03 ⇒ the pixel stays at its frame-1 value.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [0.4, 0.0, 0.0] } },
        { type: 'module', module_type: 'composite.blend', instance_key: 'acc@0',
        params: { opacity: 0.97, shape: 0.0 } },
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
    // Alpha accumulating toward 1 pulls the composited pixel from the checker
    // gray (≥128) down toward src (~102), bounded below by it. Without a
    // working delayed wire the alpha pins at 0.03 and all three phases read
    // the same checker-dominated value.
    expect(r0).toBeGreaterThan(r1);            // descending…
    expect(r1).toBeGreaterThan(r2);            // …monotonically
    expect(r0 - r2).toBeGreaterThan(10);       // clear net accumulation
    expect(r2).toBeGreaterThanOrEqual(96);     // never undershoots src (~102)
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

  it('util.dashboard pure-output knob drives a param from its authored value', async () => {
    // No input wire on the knob — its AUTHORED value (state.knob_0 = 0.5) must
    // reach captureWriteTaps and publish to brightness. white in, brightness 0.5
    // folds to neutral, contrast -0.5 → gray. If the authored knob value doesn't
    // reach the output wire, brightness stays its stored 1.0 → white.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'util.dashboard', instance_key: 'dash@0' },
        { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
      ],
      instances: {
        'dash@0': { module_type: 'util.dashboard', state: { knob_0: 0.5 } },
      },
      wires: [
        { id: 'wout', src: { instanceKey: 'dash@0', field: 'knob_0' },
          dest: { instanceKey: 'bc@0', field: 'brightness' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: 'wire_dash_out', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_dash_out' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_dash_out',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('util.sketch_output trace receives a wire write and republishes it (relay)', async () => {
    // The inverse of the dashboard: a producer writes INTO a sketch-output trace
    // (out_0), which — being a relay field (io = in|out) like a dashboard knob —
    // republishes the written value downstream. lfo.output (0.5) → so@0.out_0 →
    // brightness. gray(128) proves the value flowed THROUGH the output trace: if
    // the write into out_0 failed, brightness stays its stored 1.0 → white.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
        { type: 'module', module_type: 'util.sketch_output', instance_key: 'so@0' },
        { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
      ],
      instances: {
        'so@0': { module_type: 'util.sketch_output', state: {} },
      },
      wires: [
        { id: 'win',  src: { instanceKey: 'lfo@0', field: 'output' },
          dest: { instanceKey: 'so@0', field: 'out_0' } },
        { id: 'wout', src: { instanceKey: 'so@0', field: 'out_0' },
          dest: { instanceKey: 'bc@0', field: 'brightness' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: 'wire_sketch_out', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_sketch_out' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_sketch_out',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('a wire drives an engine-reserved key: lfo.output → invert.__opacity__', async () => {
    // Reserved-key modulation (executor-level, not a plugin field): the wire's
    // fold feeds the executor's OWN wet/dry decision. White solid → color.invert
    // at wire-driven opacity: the resting SIGNED lfo (output 0) forced unsigned
    // prescales to 0.5 → mix(white, inverted-black, 0.5) = gray(128). If the
    // wire were dropped (the old silent no-op), authored opacity 1 → black.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
        { type: 'module', module_type: 'color.invert', instance_key: 'inv@0', params: {} },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
          dest: { instanceKey: 'inv@0', field: '__opacity__' },
          combine: 'replace', magnitude: 'unsigned' },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: 'wire_reserved', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_reserved' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_reserved',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });
});
