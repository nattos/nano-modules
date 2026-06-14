import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for wire "magnitude" modes — a scalar wire maps its source into the DEST
 * field's declared range per the combine mode, instead of feeding it raw.
 *
 * Probe: white solid → data.lfo (rate 0 → constant output 0.5) → brightness_contrast,
 * with lfo.output wired into bc.brightness (declared range 0..1). bc maps
 * brightness 0.5 → neutral shift → gray(128); higher brightness → brighter.
 *   - absolute / unsigned replace: input 0.5 → brightness 0.5 → gray(128)
 *     (for a 0..1 field, unsigned replace is a pass-through == absolute)
 *   - signed replace: input 0.5 treated as bipolar → (0.5+1)/2 = 0.75 →
 *     brightness 0.75 → distinctly brighter than gray.
 * So the signed run proves the standard-range remap actually ran in the executor.
 */
describe('Wire magnitude modes E2E', () => {
  jest.setTimeout(30000);

  const build = (magnitude: 'absolute' | 'signed' | 'unsigned'): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'generator.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'data.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
      { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: 0.25 } },
    ],
    wires: [
      { id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' },
        combine: 'replace', magnitude },
    ],
  } as Sketch);

  const run = (id: string, magnitude: 'absolute' | 'signed' | 'unsigned') => runEngineTest({
    width: 64, height: 64,
    modules: ['generator.solid_color', 'data.lfo', 'video.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(magnitude) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('signed remaps the 0.5 source into the field range; unsigned == absolute for a 0..1 field', async () => {
    const abs = await run('mag_abs', 'absolute');
    const uns = await run('mag_uns', 'unsigned');
    const sgn = await run('mag_sgn', 'signed');
    expect(abs.success && uns.success && sgn.success).toBe(true);

    const absAvg = abs.trace('out').averageColor();
    const unsAvg = uns.trace('out').averageColor();
    const sgnAvg = sgn.trace('out').averageColor();

    // absolute → brightness 0.5 → neutral gray.
    abs.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    // unsigned replace on a 0..1 field is a pass-through → same as absolute.
    expect(Math.abs(unsAvg.r - absAvg.r)).toBeLessThan(6);
    // signed treats 0.5 as bipolar → brightness 0.75 → distinctly brighter.
    expect(sgnAvg.r).toBeGreaterThan(absAvg.r + 20);
  });
});
