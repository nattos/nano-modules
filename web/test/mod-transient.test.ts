import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E SMOKE for the mod.shaper.transient_shaper shaper NODE — the adaptive
 * beat-grid transient sharpener. The algorithm itself is pinned by the
 * deterministic Catch2 suite (native/tests/test_transient_shaper.cpp, which
 * controls dt/barPhase and simulates hundreds of bars); this suite only
 * verifies the wiring: registration, zero-history passthrough (a boost needs
 * learned confidence, so a fresh node passes its input through untouched),
 * the pluck secondary output's fire-and-decay, and the confidence telemetry
 * output resting at 0.
 *
 * Probe chain: white solid → transient_shaper → brightness_contrast, with a
 * chosen shaper output wired into bc.brightness (combine:'replace', unsigned):
 * with contrast -0.5 on white input, display ≈ output*255 linearly — 0 →
 * black, 0.5 → gray(128), 1 → white (same rig as mod-flip/mod-motion).
 */
describe('mod.shaper.transient_shaper shaper node E2E', () => {
  jest.setTimeout(40000);

  const build = (params: Record<string, number>, field = 'output'): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.transient_shaper', instance_key: 'ts@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'ts@0', field },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, number>, field = 'output') =>
    runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: id, sketch: build(params, field) }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: id,
    });

  // Multi-phase: create, then per phase patch shaper params and capture.
  const runPhases = (id: string, initial: Record<string, number>,
                     steps: Array<{ vals: Record<string, number>, waitFrames?: number }>,
                     field = 'output') => runEngineMultiPhaseTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    phases: [
      { commands: [
          { type: 'createSketch', sketchId: id, sketch: build(initial, field) },
          { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
        ],
        waitFrames: 15, captureTraceIds: ['out'] },
      ...steps.map(step => (
        { commands: Object.entries(step.vals).map(([paramKey, value]) => (
            { type: 'setParam' as const, sketchId: id, colIdx: 0, chainIdx: 1, paramKey, value })),
          waitFrames: step.waitFrames ?? 8, captureTraceIds: ['out'] })),
    ],
    dumpName: id,
  });

  it('registers and rests at black (no input, no ghost boost)', async () => {
    const r = await run('ts_rest', {});
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 0, g: 0, b: 0 }, 15);
  });

  it('zero history: the output passes the input through untouched', async () => {
    // A fresh node has no learned confidence — even at amount 1 a rise gets
    // no primary boost, so the output tracks the input level exactly.
    const r = await runPhases('ts_pass', { input: 0.0, amount: 1.0 },
                              [{ vals: { input: 0.5 } }]);
    expect(r.success).toBe(true);
    r.phases[0].trace('out').expectPixelAt(32, 32, { r: 0, g: 0, b: 0 }, 15);
    r.phases[1].trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('pluck output: an input step fires it bright, then it decays away', async () => {
    // Step 0 → 0.8: the onset detector fires (plucks fire on unpredicted
    // onsets too) — pluck snaps up, then releases to rest. A long release
    // (0.4 s) plus generous frame windows keep both captures dt-invariant
    // (headless rAF frames span ~4–20 ms).
    const r = await runPhases('ts_pluck', { input: 0.0, amount: 1.0, pluck_release: 0.4 },
                              [{ vals: { input: 0.8 }, waitFrames: 4 },
                               { vals: {}, waitFrames: 300 }],
                              'pluck');
    expect(r.success).toBe(true);
    const bright = r.phases[1].trace('out').pixelAt(32, 32);
    expect(bright.r).toBeGreaterThan(100);   // caught on the attack/early release
    const rest = r.phases[2].trace('out').pixelAt(32, 32);
    expect(rest.r).toBeLessThan(20);         // released back to ~0
  });

  it('confidence output reads 0 on a fresh node', async () => {
    const r = await run('ts_conf', { input: 0.5 }, 'confidence');
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 0, g: 0, b: 0 }, 15);
  });
});
