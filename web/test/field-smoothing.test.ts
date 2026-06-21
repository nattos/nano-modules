import { runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the engine-level `FieldOptions.smoothing` option — a per-parameter
 * linear ramp applied IN the executor (sketch_executor.cpp → executor.wasm on
 * web, native barrel on native), via param_smoothing.h. It was historically
 * defined (data model + inspector UI + math) but never wired into the unified
 * C++ executor; this verifies it's live again on the web path.
 *
 * Probe: gray solid → brightness_contrast (brightness 0 / contrast 0 =
 * identity = gray). Step brightness 0 → 1.0 (→ white). With a 5s smoothing
 * ramp on `brightness`, a few frames in the output is still near gray; without
 * smoothing it jumps to white. Contrast instant-vs-smoothed so it's robust to
 * the harness's real-wall-clock dt (a few frames can't complete a 5s ramp).
 */
describe('engine FieldOptions.smoothing E2E', () => {
  jest.setTimeout(40000);

  const runStep = (id: string, smoothDuration: number | null) => {
    const bc: any = {
      type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
      params: { brightness: 0.0, contrast: 0.0 },
    };
    if (smoothDuration !== null) {
      bc.fieldOptions = { brightness: { smoothing: { enabled: true, duration: smoothDuration } } };
    }
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
          params: { color: [0.5, 0.5, 0.5] } },
        bc,
      ],
    } as Sketch;
    return runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['source.solid_color', 'color.tone.brightness_contrast'],
      phases: [
        // Settle at brightness 0 (identity) → gray.
        { commands: [
            { type: 'createSketch', sketchId: id, sketch },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // Step brightness → 1.0; capture a few frames later.
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'brightness', value: 1.0 }],
          waitFrames: 6, captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });
  };

  it('linearly ramps a stepped parameter instead of jumping (vs no smoothing)', async () => {
    const instant  = await runStep('fs_instant', null);   // no smoothing
    const smoothed  = await runStep('fs_smooth', 5.0);     // 5s linear ramp
    expect(instant.success && smoothed.success).toBe(true);

    const instSettled = instant.phases[0].trace('out').averageColor().r;
    const instStep    = instant.phases[1].trace('out').averageColor().r;
    const smSettled   = smoothed.phases[0].trace('out').averageColor().r;
    const smStep      = smoothed.phases[1].trace('out').averageColor().r;

    // Both settle to gray at brightness 0 (identity).
    expect(instSettled).toBeGreaterThan(100);
    expect(instSettled).toBeLessThan(160);
    expect(smSettled).toBeGreaterThan(100);
    expect(smSettled).toBeLessThan(160);
    // No smoothing → brightness jumps to 1.0 → white.
    expect(instStep).toBeGreaterThan(215);
    // 5s ramp → a few frames in, still close to the gray start, far below the
    // instant jump. That's the smoothing.
    expect(smStep).toBeLessThan(instStep - 60);
  });
});
