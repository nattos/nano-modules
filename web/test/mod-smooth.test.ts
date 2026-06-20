import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.smooth shaper NODE — a unary modulation shaper that linearly
 * ramps an incoming modulation value toward each new target over `duration`
 * seconds, using the SAME math as the engine's built-in `FieldOptions.smoothing`
 * (param_smoothing::advanceSmooth ↔ web/src/param-smoothing.ts). The exact ramp
 * is covered by the lock-step goldens; here we prove the effect is wired right
 * end-to-end (steady-state passthrough + auto-connect) and that a stepped target
 * actually lags (temporal ramp).
 *
 * Probe: white solid → mod.smooth → brightness_contrast, with mod.smooth.output
 * wired into bc.brightness (auto/unsigned replace → pass-through). bc paints
 * gray(128) at brightness 0.5, black at 0, white at 1.
 */
describe('mod.smooth shaper node E2E', () => {
  jest.setTimeout(40000);

  it('auto-connects after a generator and passes the settled value through (duration 0)', async () => {
    // lfo(0.5) sits directly above mod.smooth → auto-connected into its input.
    // duration 0 ⇒ instant, so the output is the lfo value with no ramp: gray.
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'generator.solid_color', instance_key: 'src@0',
          params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'data.lfo', instance_key: 'lfo@0',
          params: { rate: 0.0, amplitude: 1.0 } },
        { type: 'module', module_type: 'mod.smooth', instance_key: 'sm@0',
          params: { duration: 0.0 } },
        { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0',
          params: { brightness: 1.0, contrast: 0.25 } },
      ],
      // No wire into sm@0.input — the executor auto-connects lfo@0 -> sm@0.
      wires: [
        { id: 'w1', src: { instanceKey: 'sm@0', field: 'output' },
          dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['generator.solid_color', 'data.lfo', 'mod.smooth', 'video.brightness_contrast'],
      commands: [{ type: 'createSketch', sketchId: 'sm_pass', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'sm_pass' } }],
      captureTraceIds: ['out'],
      waitFrames: 30,
      dumpName: 'sm_pass',
    });
    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 20);
  });

  // Contrast instant (duration 0) vs a long ramp at the SAME short frame count
  // after a 0→1 step: with no smoothing the output jumps to white immediately;
  // with a 5s ramp a handful of frames stay near black. Robust to the harness's
  // real-wall-clock dt — a few frames can't complete a 5s ramp either way.
  const runStep = (id: string, duration: number) => {
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'generator.solid_color', instance_key: 'src@0',
          params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'mod.smooth', instance_key: 'sm@0',
          params: { input: 0.0, duration } },
        { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0',
          params: { brightness: 1.0, contrast: 0.25 } },
      ],
      wires: [
        { id: 'w1', src: { instanceKey: 'sm@0', field: 'output' },
          dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
      ],
    } as Sketch;
    return runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['generator.solid_color', 'mod.smooth', 'video.brightness_contrast'],
      phases: [
        // Settle at input 0 → output 0 → black. (Multi-phase ignores top-level
        // tracePoints — set them via a command in the first phase.)
        { commands: [
            { type: 'createSketch', sketchId: id, sketch },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // Step input → 1; capture a few frames later.
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'input', value: 1.0 }],
          waitFrames: 6, captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });
  };

  it('a stepped target ramps gradually instead of jumping (vs instant)', async () => {
    const instant  = await runStep('sm_instant', 0.0);   // no smoothing
    const smoothed = await runStep('sm_smooth', 5.0);     // long linear ramp
    expect(instant.success && smoothed.success).toBe(true);

    const instLow  = instant.phases[0].trace('out').averageColor().r;
    const instStep = instant.phases[1].trace('out').averageColor().r;
    const smLow    = smoothed.phases[0].trace('out').averageColor().r;
    const smStep   = smoothed.phases[1].trace('out').averageColor().r;

    // Both settle to black at input 0.
    expect(instLow).toBeLessThan(40);
    expect(smLow).toBeLessThan(40);
    // duration 0 → output jumps straight to 1 → white.
    expect(instStep).toBeGreaterThan(215);
    // 5s ramp → a few frames in, the output is still far below the target,
    // markedly darker than the instant jump. That's the smoothing.
    expect(smStep).toBeLessThan(instStep - 60);
  });
});
