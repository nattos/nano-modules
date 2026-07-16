import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.latch shaper NODE — a sample-and-hold. `trigger`
 * snapshots the live `input` into the held value; `reset` drops it back to
 * `initial`, which the output then FOLLOWS (live slider) until the next
 * trigger. A same-frame trigger+reset resolves to the reset.
 *
 * Probe chain: white solid → mod.shaper.latch → brightness_contrast.
 * latch.output wires into bc.brightness (combine:'replace', unsigned): with
 * contrast -0.5 on white input, bc paints display ≈ output*255 linearly —
 * output 0 → black, 0.5 → gray(128), 1 → white (same rig as mod-flip).
 */
describe('mod.shaper.latch shaper node E2E', () => {
  jest.setTimeout(40000);

  const build = (params: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.latch', instance_key: 'la@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'la@0', field: 'output' },
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

  // Multi-phase driver: create with `initial` params, then per phase patch a
  // set of latch params (input moves, trigger/reset edges) and capture.
  const runPhases = (id: string, initial: Record<string, number>,
                     steps: Array<Record<string, number>>) => runEngineMultiPhaseTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    phases: [
      { commands: [
          { type: 'createSketch', sketchId: id, sketch: build(initial) },
          { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
        ],
        waitFrames: 15, captureTraceIds: ['out'] },
      ...steps.map(vals => (
        { commands: Object.entries(vals).map(([paramKey, value]) => (
            { type: 'setParam' as const, sketchId: id, colIdx: 0, chainIdx: 1, paramKey, value })),
          waitFrames: 8, captureTraceIds: ['out'] })),
    ],
    dumpName: id,
  });

  it('un-triggered: the output rests on (and follows) the initial value', async () => {
    const r = await run('la_rest', { input: 0.9, initial: 0.5 });
    expect(r.success).toBe(true);
    // Input 0.9 is ignored — no trigger has fired, so the output is `initial`.
    r.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('a trigger samples the input into the held value', async () => {
    const r = await run('la_sample', { input: 1.0, initial: 0.0, trigger: 1 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
  });

  it('the held value ignores later input moves', async () => {
    // Sample input 1.0, then move the input to 0.2 — the hold stays at 1.0.
    const r = await runPhases('la_hold', { input: 1.0, initial: 0.0, trigger: 1 },
                              [{ input: 0.2 }]);
    expect(r.success).toBe(true);
    r.phases[0].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
  });

  it('a new trigger re-samples the moved input', async () => {
    // Sample 1.0 → move input to 0.5 (still holds 1.0) → trigger again: 0.5.
    const r = await runPhases('la_resample', { input: 1.0, initial: 0.0, trigger: 1 },
                              [{ input: 0.5, trigger: 0 }, { trigger: 1 }]);
    expect(r.success).toBe(true);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
    r.phases[2].trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('reset abandons the hold and returns to the initial value', async () => {
    // Sample 1.0 (white), then reset → back to initial 0.5 (gray) even though
    // the input still reads 1.0.
    const r = await runPhases('la_reset', { input: 1.0, initial: 0.5, trigger: 1 },
                              [{ reset: 1 }]);
    expect(r.success).toBe(true);
    r.phases[0].trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 15);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('after a reset the output follows the initial slider live', async () => {
    // Sample 1.0 → reset to initial 0.5 → drag initial to 0.0: the resting
    // output tracks it down to black without another event.
    const r = await runPhases('la_follow', { input: 1.0, initial: 0.5, trigger: 1 },
                              [{ reset: 1 }, { initial: 0.0 }]);
    expect(r.success).toBe(true);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    r.phases[2].trace('out').expectPixelAt(32, 32, { r: 0, g: 0, b: 0 }, 15);
  });
});
