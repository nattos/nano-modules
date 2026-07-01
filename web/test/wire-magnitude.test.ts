import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for wire "magnitude" modes — a scalar wire maps its source into the DEST
 * field's declared range per the combine mode, instead of feeding it raw.
 *
 * Probe: white solid → mod.source.lfo → brightness_contrast, with lfo.output
 * wired into bc.brightness (a SIGNED range −1..1). With contrast −0.5 (0.5×
 * scale) on white, a neutral brightness (0) reads gray(128).
 *
 * mod.source.lfo.output is a SIGNED [−1,1] channel that rests at 0 and a Square
 * wave pins to ±1 — all EXTREMES, where the magnitude modes converge. To pull
 * the modes apart we exercise them at a MID value (0.5): the first case pins the
 * wire's shaped value to a constant 0.5 via a remap.
 *   - absolute replace: feeds the raw 0.5 → shift +0.5 → (1+0.5)*0.5 = 0.75 → ~191.
 *   - unsigned replace: folds 0.5 into [−1,1] → 0 (neutral) → gray(128).
 *   - signed replace: the source is ALREADY signed, so `signed` takes 0.5 at
 *     face value (no rescale) → 0.5 → ~191, matching absolute. (`signed` only
 *     diverges from absolute for a source declared *unsigned*, where it rescales
 *     0..1 → −1..1.)
 */
describe('Wire magnitude modes E2E', () => {
  jest.setTimeout(30000);

  const build = (magnitude: 'absolute' | 'signed' | 'unsigned', mod?: any): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      // Square wave @ rate 0 → deterministic raw output of +1 (an exact,
      // frame-independent value for the scale/remap case below).
      { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0, waveform: 1 } },
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

  it('absolute & signed pass a mid value raw; unsigned folds it to the bipolar neutral', async () => {
    // Pin the wire's shaped value to a constant 0.5 (independent of the source's
    // signed rest/extreme values) so the magnitude modes diverge.
    const MID = { remap: { inMin: 0, inMax: 1, outMin: 0.5, outMax: 0.5 } };
    const abs = await run('mag_abs', 'absolute', MID);
    const uns = await run('mag_uns', 'unsigned', MID);
    const sgn = await run('mag_sgn', 'signed', MID);
    expect(abs.success && uns.success && sgn.success).toBe(true);

    const absAvg = abs.trace('out').averageColor();
    const unsAvg = uns.trace('out').averageColor();
    const sgnAvg = sgn.trace('out').averageColor();

    // absolute feeds the raw 0.5 → shift +0.5 → (1+0.5)*0.5 = 0.75 → ~191.
    abs.trace('out').expectPixelAt(32, 32, { r: 191, g: 191, b: 191 }, 15);
    // unsigned replace folds 0.5 into the signed [-1,1] → 0 (neutral) → gray(128).
    uns.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    // signed takes the already-signed source at face value → matches absolute.
    expect(Math.abs(sgnAvg.r - absAvg.r)).toBeLessThan(6);
    // absolute & signed (raw 0.5) are clearly brighter than the folded-neutral gray.
    expect(absAvg.r).toBeGreaterThan(unsAvg.r + 30);
  });

  it('scale + remap shape the RAW input before the range adjustment (not absolute-only)', async () => {
    // Square source (+1). Unmodded unsigned → white; halving the value via either
    // scale OR a remap to 0..0.5 pulls it to 0.5, which folds to the signed
    // neutral (~gray 128), proving scale/remap run in non-absolute modes on the
    // raw input.
    const plain = await run('mod_plain', 'unsigned');
    const scaled = await run('mod_scale', 'unsigned', { scale: 0.5 });
    const remapped = await run('mod_remap', 'unsigned', { remap: { inMin: 0, inMax: 1, outMin: 0, outMax: 0.5 } });
    expect(plain.success && scaled.success && remapped.success).toBe(true);

    const p = plain.trace('out').averageColor().r;
    const s = scaled.trace('out').averageColor().r;
    const r = remapped.trace('out').averageColor().r;
    expect(p).toBeGreaterThan(200);          // raw +1 → white
    expect(s).toBeLessThan(p - 30);          // scale halved it → ~gray
    expect(r).toBeLessThan(p - 30);          // remap halved it → ~gray
    expect(Math.abs(s - r)).toBeLessThan(10); // both reach ~the same lower value
  });
});
