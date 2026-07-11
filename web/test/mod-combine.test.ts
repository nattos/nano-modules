import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.combine shaper NODE — a BINARY modulation shaper that
 * combines two scalar inputs (input_a, input_b) with a selectable math op and
 * republishes the result on `output`.
 *
 * Probe chain: white solid → mod.shaper.combine → brightness_contrast.
 * combine.output wires into bc.brightness (combine:'replace', unsigned → the
 * value passes straight into [0,1]), so bc paints gray(value*255). Since bc's
 * contrast is -0.5, the 0.5 pivot is exact (gray 128) but other values are
 * pulled toward mid — so we anchor absolute checks at 0.5 and use RELATIVE
 * ordering elsewhere (same approach as mod-remap.test.ts).
 *
 * Inputs are set via params (source.solid_color is NOT a modulation source, so
 * the shaper auto-connect does not fire here — input_a/input_b keep their
 * authored slider values). Op values: Add 0, Subtract 1, Multiply 2, Divide 3,
 * Min 4, Max 5, Average 6, Difference 7, Screen 8, Power 9, Modulo 10,
 * Greater 11, Less 12, Hypot 13.
 */
describe('mod.shaper.combine shaper node E2E', () => {
  jest.setTimeout(30000);

  const build = (params: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.combine', instance_key: 'cb@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'cb@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, number>) => runEngineTest({
    width: 64, height: 64,
    // Load the shipping `core` bundle directly (it holds solid_color,
    // brightness_contrast, and mod.shaper.combine) — per-effect e2e tests run
    // against shipping code, not the testonly forks.
    modules: ['com.nano.core'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(params) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('add sums the two inputs; multiply is darker', async () => {
    // add: 0.25 + 0.25 = 0.5 → exact gray pivot.
    const add = await run('cb_add', { op: 0, input_a: 0.25, input_b: 0.25 });
    // multiply: 0.5 * 0.5 = 0.25 → distinctly darker.
    const mul = await run('cb_mul', { op: 2, input_a: 0.5, input_b: 0.5 });
    expect(add.success && mul.success).toBe(true);

    // add → 0.5 → neutral gray (contrast pivot, exact).
    add.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    // multiply's 0.25 is below the pivot → markedly darker than the 0.5 pivot.
    const a = add.trace('out').averageColor().r;
    const m = mul.trace('out').averageColor().r;
    expect(m).toBeLessThan(a - 30);
  });

  it('max takes the larger input, min the smaller', async () => {
    const mx = await run('cb_max', { op: 5, input_a: 0.2, input_b: 0.8 });
    const mn = await run('cb_min', { op: 4, input_a: 0.2, input_b: 0.8 });
    expect(mx.success && mn.success).toBe(true);
    const hi = mx.trace('out').averageColor().r;
    const lo = mn.trace('out').averageColor().r;
    // max(0.2,0.8)=0.8 is much brighter than min(0.2,0.8)=0.2.
    expect(hi).toBeGreaterThan(lo + 60);
  });

  it('per-input gain scales the input before the op', async () => {
    // gain_a=2 doubles input_a 0.25 → 0.5 (add with b=0) → exact gray pivot.
    const gain = await run('cb_gain', { op: 0, input_a: 0.25, input_b: 0.0, gain_a: 2.0 });
    // Same input at unit gain → 0.25 → darker.
    const unit = await run('cb_unit', { op: 0, input_a: 0.25, input_b: 0.0, gain_a: 1.0 });
    expect(gain.success && unit.success).toBe(true);
    gain.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    const g = gain.trace('out').averageColor().r;
    const u = unit.trace('out').averageColor().r;
    expect(g).toBeGreaterThan(u + 30);
  });

  it('post scale multiplies the op result', async () => {
    // add 0.5+0.5=1.0 → white; scale 0.5 → 0.5 → gray pivot.
    const full = await run('cb_full', { op: 0, input_a: 0.5, input_b: 0.5, scale: 1.0 });
    const half = await run('cb_half', { op: 0, input_a: 0.5, input_b: 0.5, scale: 0.5 });
    expect(full.success && half.success).toBe(true);
    half.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    const f = full.trace('out').averageColor().r;
    const h = half.trace('out').averageColor().r;
    expect(f).toBeGreaterThan(h + 40);   // full (white) brighter than half (gray)
  });
});

/**
 * Auto-connect QoL: a modulation shaper placed DIRECTLY after a modulation
 * source gets its PRIMARY input wired from the source's output by the executor,
 * with NO wire drawn. For a binary shaper only `input_a` (PrimaryInput) is
 * auto-picked; `input_b` (SecondaryInput) is user-wired or slider-set.
 *
 * We drive a SQUARE lfo (waveform 1) at rate 0: its raw output rests at a
 * deterministic +1 — a NON-default value (input_a defaults to 0). The ONLY
 * explicit wire is cb.output -> bc.brightness. With op=Add and input_b=0, if the
 * auto-connect fires input_a=+1 → output 1 → white; if it did NOT, input_a stays
 * 0 → output 0 → black.
 */
describe('mod.shaper.combine source->shaper auto-connect E2E', () => {
  jest.setTimeout(30000);

  const build = (params: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      // Square wave @ rate 0 → deterministic raw output of +1.
      { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0, waveform: 1 } },
      { type: 'module', module_type: 'mod.shaper.combine', instance_key: 'cb@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    // NOTE: no wire into cb@0.input_a — the executor auto-connects lfo@0 -> cb@0.
    wires: [
      { id: 'w1', src: { instanceKey: 'cb@0', field: 'output' },
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

  it('auto-wires the adjacent lfo into input_a (raw +1 → white, not black)', async () => {
    const r = await run('cb_ac', { op: 0, input_b: 0.0 });   // add, b=0 → output = input_a
    expect(r.success).toBe(true);
    // Proves the lfo's raw +1 reached cb.input_a via auto-connect (else black).
    r.trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 20);
  });

  it('the auto-connected input combines with a slider-set input_b', async () => {
    // Multiply auto-wired input_a (+1) by slider input_b (0.5) → 0.5 → gray pivot.
    const r = await run('cb_ac_mul', { op: 2, input_b: 0.5 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 20);
  });
});
