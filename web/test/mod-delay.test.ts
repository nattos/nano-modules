import { runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.delay shaper NODE — a unary modulation shaper that delays its
 * `input` by `delay` seconds via a time-stamped ring-buffer delay line
 * (delay_line.h). The interpolation/clamp/wraparound math is covered by the
 * native goldens; here we prove the effect is wired right and actually HOLDS the
 * old value end-to-end.
 *
 * Probe: white solid → mod.delay → brightness_contrast, with mod.delay.output
 * wired into bc.brightness (brightness 0 → black, 1 → white). Step input 0 → 1.
 * With delay 0 the output jumps immediately (white); with a 5s delay the new
 * value is still "in the pipe" a few frames later (output 0 → black). Contrast
 * the two so it's robust to the harness's real-wall-clock dt.
 */
describe('mod.delay shaper node E2E', () => {
  jest.setTimeout(40000);

  const runStep = (id: string, delay: number) => {
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'generator.solid_color', instance_key: 'src@0',
          params: { color: [1.0, 1.0, 1.0] } },
        { type: 'module', module_type: 'mod.delay', instance_key: 'dl@0',
          params: { input: 0.0, delay } },
        { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0',
          params: { brightness: 1.0, contrast: 0.25 } },
      ],
      wires: [
        { id: 'w1', src: { instanceKey: 'dl@0', field: 'output' },
          dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
      ],
    } as Sketch;
    return runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['generator.solid_color', 'mod.delay', 'video.brightness_contrast'],
      phases: [
        // Settle at input 0 → output 0 → black.
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

  it('holds the old value for the delay time instead of passing it through (vs delay 0)', async () => {
    const instant = await runStep('dl_instant', 0.0);   // passthrough
    const delayed = await runStep('dl_delayed', 5.0);    // 5s delay line
    expect(instant.success && delayed.success).toBe(true);

    const instSettled = instant.phases[0].trace('out').averageColor().r;
    const instStep    = instant.phases[1].trace('out').averageColor().r;
    const dlSettled   = delayed.phases[0].trace('out').averageColor().r;
    const dlStep      = delayed.phases[1].trace('out').averageColor().r;

    // Both settle to black at input 0.
    expect(instSettled).toBeLessThan(40);
    expect(dlSettled).toBeLessThan(40);
    // delay 0 → the stepped value passes straight through → brightness 1 → white.
    expect(instStep).toBeGreaterThan(215);
    // 5s delay → a few frames later the new value hasn't arrived; output is still
    // the old (black) value, far below the instant passthrough.
    expect(dlStep).toBeLessThan(instStep - 60);
  });
});
