import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.remap shaper NODE — a unary modulation shaper that runs an
 * incoming modulation value through the SAME range-remapper the wire-options
 * "remap" uses (tap_mod::applyTapMod), then republishes it on `output`.
 *
 * Probe chain: white solid → mod.source.lfo (rate 0 → constant 0.5) → mod.shaper.remap →
 * brightness_contrast. lfo.output (0.5) wires into mod.shaper.remap.input; mod.shaper.remap.output
 * wires into bc.brightness (declared 0..1, auto/unsigned replace → pass-through).
 * So bc paints gray(128) at brightness 0.5, darker below, brighter above. The
 * downstream value is whatever the remap node produced — proving the node ran
 * the remap end-to-end (the web executor mirrors the node's live output into
 * instance state, which the bc wire reads).
 */
describe('mod.shaper.remap shaper node E2E', () => {
  jest.setTimeout(30000);

  // `remap` is the mod.shaper.remap node's own param set (snake_case schema fields).
  const build = (id: string, remap: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
      { type: 'module', module_type: 'mod.shaper.remap', instance_key: 'rm@0',
        params: remap },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
        dest: { instanceKey: 'rm@0', field: 'input' }, combine: 'replace' },
      { id: 'w1', src: { instanceKey: 'rm@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, remap: Record<string, number>) => runEngineTest({
    width: 64, height: 64,
    modules: ['source.solid_color', 'mod.source.lfo', 'mod.shaper.remap', 'color.tone.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(id, remap) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('identity remap passes the value through; an output window scales it', async () => {
    // Identity window (in 0..1 → out 0..1): input 0.5 → output 0.5 → gray.
    const ident = await run('rm_ident', { in_min: 0, in_max: 1, out_min: 0, out_max: 1 });
    // Half the output window (out 0..0.5): output 0.25 → distinctly darker.
    const half = await run('rm_half', { in_min: 0, in_max: 1, out_min: 0, out_max: 0.5 });
    expect(ident.success && half.success).toBe(true);

    const i = ident.trace('out').averageColor().r;
    const h = half.trace('out').averageColor().r;

    // Identity → brightness 0.5 → neutral gray.
    ident.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    // Halving the output window halves the published value → markedly darker.
    expect(h).toBeLessThan(i - 30);
  });

  it('an offset output window lifts the value (out 0.5..1.0)', async () => {
    // out 0.5..1.0: input 0.5 → 0.5 + 0.5*0.5 = 0.75 → brighter than gray.
    const ident = await run('rm_lift_ident', { in_min: 0, in_max: 1, out_min: 0, out_max: 1 });
    const lift = await run('rm_lift', { in_min: 0, in_max: 1, out_min: 0.5, out_max: 1.0 });
    expect(ident.success && lift.success).toBe(true);

    const i = ident.trace('out').averageColor().r;
    const l = lift.trace('out').averageColor().r;
    expect(l).toBeGreaterThan(i + 20);
  });
});

/**
 * Auto-connect QoL: a modulation shaper placed DIRECTLY after a modulation
 * generator gets its modulation input wired from the generator's output by the
 * executor, with NO wire drawn. The synthesised wire carries the producer's
 * output RAW (`magnitude:"absolute"`, value flows through untouched) — shapers
 * receive the unmapped signal and normalise it themselves via their in-window.
 *
 * We drive a SQUARE lfo (waveform 1) at rate 0: its raw output rests at a
 * deterministic +1 — a NON-default value (the shaper input defaults to 0), so a
 * white result proves the auto-connect actually delivered it. The ONLY explicit
 * wire is rm.output -> bc.brightness; nothing feeds rm.input. If the auto-connect
 * fires, rm.input = lfo.output (+1) → identity remap over [0,1] → 1 → white. If
 * it did NOT, rm.input stays at its default 0 → output 0 → brightness 0 → black.
 */
describe('mod.shaper.remap generator->shaper auto-connect E2E', () => {
  jest.setTimeout(30000);

  const build = (id: string, remap: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      // Square wave @ rate 0 → deterministic raw output of +1 (≠ the input's default 0).
      { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0, waveform: 1 } },
      { type: 'module', module_type: 'mod.shaper.remap', instance_key: 'rm@0',
        params: remap },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    // NOTE: no wire into rm@0.input — the executor auto-connects lfo@0 -> rm@0.
    wires: [
      { id: 'w1', src: { instanceKey: 'rm@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, remap: Record<string, number>) => runEngineTest({
    width: 64, height: 64,
    modules: ['source.solid_color', 'mod.source.lfo', 'mod.shaper.remap', 'color.tone.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(id, remap) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('auto-wires the adjacent lfo into the shaper input (raw +1 → white, not black)', async () => {
    const ident = await run('ac_ident', { in_min: 0, in_max: 1, out_min: 0, out_max: 1 });
    expect(ident.success).toBe(true);
    // Proves the lfo's raw +1 reached rm.input via auto-connect (else this is black).
    ident.trace('out').expectPixelAt(32, 32, { r: 255, g: 255, b: 255 }, 20);
  });

  it('the auto-connected value flows through the shaper curve (half window → darker)', async () => {
    const ident = await run('ac_ident2', { in_min: 0, in_max: 1, out_min: 0, out_max: 1 });
    const half = await run('ac_half', { in_min: 0, in_max: 1, out_min: 0, out_max: 0.5 });
    expect(ident.success && half.success).toBe(true);
    const i = ident.trace('out').averageColor().r;
    const h = half.trace('out').averageColor().r;
    expect(i).toBeGreaterThan(200);          // raw +1 → identity → white
    expect(h).toBeLessThan(i - 30);          // half output window → +1 → 0.5 → ~gray
  });
});
