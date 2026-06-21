import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for wire "magnitude" modes — a scalar wire maps its source into the DEST
 * field's declared range per the combine mode, instead of feeding it raw.
 *
 * Probe: white solid → mod.source.lfo (rate 0 → constant output 0.5) → brightness_contrast,
 * with lfo.output wired into bc.brightness (now a SIGNED range −1..1). With
 * contrast −0.5 (0.5× scale) on white, a neutral brightness (0) reads gray(128).
 *   - absolute replace: feeds the raw 0.5 → shift +0.5 → (1+0.5)*0.5 = 0.75 → ~191.
 *   - unsigned replace: folds 0.5 into [−1,1] → 0 (neutral) → gray(128). On a
 *     SIGNED field this no longer equals absolute (it does for a 0..1 field).
 *   - signed replace: mod.source.lfo.output is declared *unsigned*, so forcing `signed`
 *     RESCALES the source 0..1 → −1..1 (the polarity prescale); the midpoint 0.5
 *     maps to bipolar 0 (neutral) → gray(128), matching unsigned (NOT absolute).
 */
describe('Wire magnitude modes E2E', () => {
  jest.setTimeout(30000);

  const build = (magnitude: 'absolute' | 'signed' | 'unsigned', mod?: any): Sketch => ({
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
        dest: { instanceKey: 'bc@0', field: 'brightness' },
        combine: 'replace', magnitude, ...(mod ? { mod } : {}) },
    ],
  } as Sketch);

  const run = (id: string, magnitude: 'absolute' | 'signed' | 'unsigned', mod?: any) => runEngineTest({
    width: 64, height: 64,
    modules: ['source.solid_color', 'mod.source.lfo', 'color.tone.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(magnitude, mod) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('absolute passes a 0.5 source raw; unsigned & signed fold it to the bipolar neutral', async () => {
    const abs = await run('mag_abs', 'absolute');
    const uns = await run('mag_uns', 'unsigned');
    const sgn = await run('mag_sgn', 'signed');
    expect(abs.success && uns.success && sgn.success).toBe(true);

    const absAvg = abs.trace('out').averageColor();
    const unsAvg = uns.trace('out').averageColor();
    const sgnAvg = sgn.trace('out').averageColor();

    // absolute feeds the raw 0.5 → shift +0.5 → (1+0.5)*0.5 = 0.75 → ~191.
    abs.trace('out').expectPixelAt(32, 32, { r: 191, g: 191, b: 191 }, 15);
    // unsigned replace folds 0.5 into the signed [-1,1] → 0 (neutral) → gray(128).
    uns.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    // signed rescales the unsigned source 0..1 → −1..1: midpoint 0.5 → 0 (neutral),
    // matching unsigned (NOT absolute).
    expect(Math.abs(sgnAvg.r - unsAvg.r)).toBeLessThan(6);
    // absolute (raw 0.5) is clearly brighter than the folded-neutral gray.
    expect(absAvg.r).toBeGreaterThan(unsAvg.r + 30);
  });

  it('scale + remap shape the RAW input before the range adjustment (not absolute-only)', async () => {
    // Source 0.5. Unmodded auto → brightness 0.5 → gray 128. Halving the value
    // via either scale OR a remap to 0..0.5 must roughly halve it (~gray 64),
    // proving scale/remap run in non-absolute modes on the raw input.
    const plain = await run('mod_plain', 'unsigned');
    const scaled = await run('mod_scale', 'unsigned', { scale: 0.5 });
    const remapped = await run('mod_remap', 'unsigned', { remap: { inMin: 0, inMax: 1, outMin: 0, outMax: 0.5 } });
    expect(plain.success && scaled.success && remapped.success).toBe(true);

    const p = plain.trace('out').averageColor().r;
    const s = scaled.trace('out').averageColor().r;
    const r = remapped.trace('out').averageColor().r;
    expect(p).toBeGreaterThan(100);          // ~128
    expect(s).toBeLessThan(p - 30);          // scale halved it
    expect(r).toBeLessThan(p - 30);          // remap halved it
    expect(Math.abs(s - r)).toBeLessThan(10); // both reach ~the same lower value
  });
});
