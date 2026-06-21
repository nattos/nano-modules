import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.envelope shaper NODE — a unary modulation shaper that remaps
 * its `input` through a drawn envelope curve (a flat "[x0,y0,e0, ...]" string,
 * parsed + evaluated by native/src/sketch/envelope.h). The curve math/parser is
 * covered by the native goldens; here we prove the effect remaps end-to-end
 * through executor.wasm.
 *
 * Probe: white solid → mod.shaper.envelope → brightness_contrast, with mod.shaper.envelope.output
 * wired into bc.brightness (output 0 → black, 0.5 → gray, 1 → white). `input` and
 * `curve` are set as params (input not wired → preceding solid isn't a generator,
 * so no auto-connect).
 */
describe('mod.shaper.envelope shaper node E2E', () => {
  jest.setTimeout(30000);

  // A peak curve: rises 0→1 over x∈[0,0.5], falls 1→0 over [0.5,1] (linear).
  const PEAK = '[0,0,0, 0.5,1,0, 1,0,0]';

  const build = (id: string, input: number, curve?: string): Sketch => {
    const env: any = {
      type: 'module', module_type: 'mod.shaper.envelope', instance_key: 'env@0',
      params: curve !== undefined ? { input, curve } : { input },
    };
    return {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
          params: { color: [1.0, 1.0, 1.0] } },
        env,
        { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
          params: { brightness: 1.0, contrast: -0.5 } },
      ],
      wires: [
        { id: 'w1', src: { instanceKey: 'env@0', field: 'output' },
          dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
      ],
    } as Sketch;
  };

  const run = (id: string, input: number, curve?: string) => runEngineTest({
    width: 64, height: 64,
    modules: ['source.solid_color', 'mod.shaper.envelope', 'color.tone.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(id, input, curve) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('default identity curve passes the input through', async () => {
    // No curve → default "[0,0,0,1,1,0]" identity: input 0.5 → 0.5 → gray.
    const ident = await run('env_ident', 0.5);
    expect(ident.success).toBe(true);
    ident.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 20);
  });

  it('remaps the input through a drawn curve', async () => {
    // Peak curve: input 0.5 sits at the peak → output 1.0 → white.
    const peakMid = await run('env_peak_mid', 0.5, PEAK);
    // input 0.0 → output 0.0 → black.
    const peakLow = await run('env_peak_low', 0.0, PEAK);
    expect(peakMid.success && peakLow.success).toBe(true);

    const mid = peakMid.trace('out').averageColor().r;
    const low = peakLow.trace('out').averageColor().r;
    // The curve lifted 0.5 to the peak (white) and held 0.0 at black.
    expect(mid).toBeGreaterThan(215);
    expect(low).toBeLessThan(40);
  });
});
