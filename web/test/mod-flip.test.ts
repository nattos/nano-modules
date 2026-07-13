import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.flip shaper NODE — a trigger-flipped latch with MIDI
 * "pickup" takeover. The output follows `input` until `trigger` fires: the
 * output then slams to the opposite rail (an exact 0.0 or 1.0) and holds it;
 * when the input later reaches the rail (within an epsilon) or crosses to the
 * other side, it takes over and the output follows it again.
 *
 * Probe chain: white solid → mod.shaper.flip → brightness_contrast.
 * flip.output wires into bc.brightness (combine:'replace', unsigned): with
 * contrast -0.5 on white input, bc paints display ≈ output*255 linearly —
 * output 0 → black, 0.5 → gray(128), 1 → white (same rig as mod-combine).
 */
describe('mod.shaper.flip shaper node E2E', () => {
  jest.setTimeout(40000);

  const build = (params: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.flip', instance_key: 'fl@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'fl@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, number>) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(params) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('latched by default: the output follows the input (passthrough)', async () => {
    const r = await run('fl_pass', { input: 0.5 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('a trigger on a LOW input flips the output to exactly 1.0 and holds it', async () => {
    // input 0.3 (< 0.5 = low) + trigger → rail 1.0; 0.3 stays below → held.
    const r = await run('fl_high', { input: 0.3, trigger: 1 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
  });

  it('a trigger on a HIGH input flips the output to exactly 0.0 and holds it', async () => {
    // input 0.7 (>= 0.5 = high) + trigger → rail 0.0; 0.7 stays above → held.
    const r = await run('fl_low', { input: 0.7, trigger: 1 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 0, g: 0, b: 0 }, 15);
  });

  // Multi-phase: the pickup semantics. After a flip to 1.0, moving the input
  // WITHOUT reaching the rail leaves the output held; touching the rail takes
  // over, and the output follows the input back down.
  const runPhases = (id: string, inputSteps: number[]) => runEngineMultiPhaseTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    phases: [
      { commands: [
          { type: 'createSketch', sketchId: id, sketch: build({ input: 0.3, trigger: 1 }) },
          { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
        ],
        waitFrames: 15, captureTraceIds: ['out'] },
      ...inputSteps.map(v => (
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'input', value: v }],
          waitFrames: 8, captureTraceIds: ['out'] })),
    ],
    dumpName: id,
  });

  it('the held rail ignores input moves that do not reach it', async () => {
    // Flip to 1.0 at input 0.3, then move the input to 0.6 — still below the
    // rail (same side), so the output stays parked at 1.0.
    const r = await runPhases('fl_hold', [0.6]);
    expect(r.success).toBe(true);
    r.phases[0].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
  });

  it('the input takes over when it reaches the rail, then the output follows it', async () => {
    // Flip to 1.0 at input 0.3 → push the input to 1.0 (touches the rail →
    // takeover) → pull it back to 0.5: the output follows down to 0.5.
    // Without the takeover the last phase would still paint white.
    const r = await runPhases('fl_takeover', [1.0, 0.5]);
    expect(r.success).toBe(true);
    r.phases[0].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
    r.phases[2].trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });
});
