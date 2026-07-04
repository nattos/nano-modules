import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.threshold shaper NODE — a unary modulation shaper that
 * compares an incoming modulation value against a threshold and emits either a
 * sustained gate (Hold) or a one-frame edge trigger (Up / Down / Any Edge).
 *
 * Probe: white solid → mod.shaper.threshold → brightness_contrast, with
 * threshold.output wired into bc.brightness (auto/unsigned replace folds the
 * source [0,1] into brightness's signed [-1,1]). With contrast -0.5 (0.5× scale)
 * on white input, bc paints white at output 1 (brightness +1) and black at
 * output 0 (brightness -1). So "output high" == white, "output low/off" == black.
 *
 * The edge modes fire a strictly one-frame pulse, and the harness captures only
 * the last frame of each wait window, so the deterministic checks are:
 *   - Hold: a static input above/below the threshold gives a stable white/black.
 *   - Edge modes are MOMENTARY: a static above-threshold input never crossed, so
 *     it reads black (0), unlike Hold which sustains white — proving the pulse
 *     doesn't latch into a gate.
 *   - A crossing fires: a step across the threshold, captured one frame later
 *     (waitFrames: 1), lands on the pulse → white.
 */
describe('mod.shaper.threshold shaper node E2E', () => {
  jest.setTimeout(40000);

  // Load the whole core bundle: it carries source.solid_color,
  // mod.shaper.threshold, and color.tone.brightness_contrast. (The per-effect
  // legacy alias list in the harness doesn't know this new effect, so we pull
  // its real bundle rather than the testonly fork.)
  const MODULES = ['com.nano.core'];

  // solid(white) → threshold(mode, input) → bc(brightness 1, contrast -0.5),
  // threshold.output → bc.brightness. solid_color has no modulation output, so
  // the shaper's `input` param stands (no auto-connect steals it).
  const makeSketch = (mode: number, input: number, threshold = 0.5): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.threshold', instance_key: 'th@0',
        params: { input, threshold, mode } },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'th@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const runStatic = (id: string, mode: number, input: number) =>
    runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: id, sketch: makeSketch(mode, input) }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: id,
    });

  it('Hold gates high above the threshold and low at/below it', async () => {
    const above = await runStatic('th_hold_hi', 0, 0.8);  // 0.8 > 0.5 → gate on
    const below = await runStatic('th_hold_lo', 0, 0.2);  // 0.2 < 0.5 → gate off
    expect(above.success && below.success).toBe(true);
    // Above → output 1 → white; at/below → output 0 → black.
    expect(above.trace('out').averageColor().r).toBeGreaterThan(215);
    expect(below.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('edge modes are momentary: a static above-threshold input never latches (vs Hold)', async () => {
    // Same static-high input (0.8). Hold sustains a gate; Up Edge only ever pulses
    // on a crossing, and there is none here (it started above), so the captured
    // steady-state frame is black — the pulse does not become a gate.
    const hold = await runStatic('th_static_hold', 0, 0.8);
    const edge = await runStatic('th_static_up', 1, 0.8);
    expect(hold.success && edge.success).toBe(true);
    expect(hold.trace('out').averageColor().r).toBeGreaterThan(215); // sustained gate
    expect(edge.trace('out').averageColor().r).toBeLessThan(40);      // no sustained pulse
  });

  // The edge pulse is strictly one frame — far too brief to land on the harness's
  // single captured frame. To prove firing deterministically, latch the pulse
  // into a slow-decaying ADSR (mode Decay, decay 1.0 ≈ 4s): threshold.output →
  // adsr.trigger, adsr.output → bc.brightness. Once the crossing fires the ADSR,
  // its envelope stays high for seconds, so any captured frame reads bright.
  // auto_rate 0 + gate off ⇒ the ADSR only ever fires from our edge pulse.
  const makeEdgeSketch = (mode: number, input: number): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.threshold', instance_key: 'th@0',
        params: { input, threshold: 0.5, mode } },
      { type: 'module', module_type: 'mod.source.adsr', instance_key: 'ad@0',
        params: { mode: 0, decay: 1.0, auto_rate: 0.0, gate: false } },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'th@0', field: 'output' },
        dest: { instanceKey: 'ad@0', field: 'trigger' }, combine: 'replace' },
      { id: 'w2', src: { instanceKey: 'ad@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const runEdge = (id: string, mode: number, settleInput: number, stepInput: number) =>
    runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        // Settle on one side of the threshold: no crossing, ADSR idle → black.
        { commands: [
            { type: 'createSketch', sketchId: id, sketch: makeEdgeSketch(mode, settleInput) },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // Cross the threshold → one-frame pulse → ADSR fires → stays lit for ~4s.
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'input', value: stepInput }],
          waitFrames: 8, captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });

  it('Up Edge fires a pulse when the input crosses up past the threshold', async () => {
    const r = await runEdge('th_up', 1, 0.2, 0.8);   // below → above
    expect(r.success).toBe(true);
    const settled = r.phases[0].trace('out').averageColor().r;  // steady-state, no edge → black
    const lit     = r.phases[1].trace('out').averageColor().r;  // ADSR latched the pulse
    expect(settled).toBeLessThan(40);
    expect(lit).toBeGreaterThan(settled + 150);
  });

  it('Down Edge fires a pulse when the input crosses down past the threshold', async () => {
    const r = await runEdge('th_down', 2, 0.8, 0.2);  // above → below
    expect(r.success).toBe(true);
    const settled = r.phases[0].trace('out').averageColor().r;  // above but no crossing → black
    const lit     = r.phases[1].trace('out').averageColor().r;
    expect(settled).toBeLessThan(40);
    expect(lit).toBeGreaterThan(settled + 150);
  });

  it('Any Edge fires on a down crossing too (not just up)', async () => {
    // Mode 3 = Any Edge, driven across a DOWN crossing — where Up Edge would stay
    // silent — so this proves Any responds to either direction.
    const r = await runEdge('th_any', 3, 0.8, 0.2);  // above → below
    expect(r.success).toBe(true);
    const settled = r.phases[0].trace('out').averageColor().r;
    const lit     = r.phases[1].trace('out').averageColor().r;
    expect(settled).toBeLessThan(40);
    expect(lit).toBeGreaterThan(settled + 150);
  });
});
