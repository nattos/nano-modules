import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for CHAINING shapers: a shaper directly after another shaper auto-connects
 * too (not only after a source). Probe: white solid → data.lfo (0.5) →
 * mod.smooth → mod.envelope → brightness_contrast, with ONLY envelope.output
 * wired into bc.brightness. The lfo→smooth and smooth→envelope hops auto-connect.
 *
 * With a PEAK envelope curve, input 0.5 maps to the peak (1.0), so the value
 * flows lfo(0.5) → smooth(0.5) → envelope(1.0) → brightness 1.0 → white. If the
 * second hop didn't auto-connect, envelope.input would stay 0 → output 0 → black.
 */
describe('modulation shaper chaining E2E', () => {
  jest.setTimeout(40000);

  const PEAK = '[0,0,0, 0.5,1,0, 1,0,0]';

  const build = (id: string, curve: string): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'generator.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'data.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0 } },
      { type: 'module', module_type: 'mod.smooth', instance_key: 'sm@0',
        params: { duration: 0.0 } },
      { type: 'module', module_type: 'mod.envelope', instance_key: 'env@0',
        params: { curve } },
      { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: 0.25 } },
    ],
    // Only the final hop is drawn; lfo→smooth and smooth→envelope auto-connect.
    wires: [
      { id: 'w1', src: { instanceKey: 'env@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, curve: string) => runEngineTest({
    width: 64, height: 64,
    modules: ['generator.solid_color', 'data.lfo', 'mod.smooth', 'mod.envelope', 'video.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(id, curve) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 30,   // generous: the value mirrors one hop per frame
    dumpName: id,
  });

  it('a value flows through a chain of auto-connected shapers', async () => {
    // Identity envelope: 0.5 passes lfo→smooth→envelope unchanged → gray.
    const ident = await run('chain_ident', '[0,0,0,1,1,0]');
    // Peak envelope: the auto-connected 0.5 lands on the peak → white.
    const peak = await run('chain_peak', PEAK);
    expect(ident.success && peak.success).toBe(true);

    const i = ident.trace('out').averageColor().r;
    const p = peak.trace('out').averageColor().r;
    // Identity → 0.5 → gray; if the chain hadn't connected this would be black.
    expect(i).toBeGreaterThan(100);
    expect(i).toBeLessThan(160);
    // Peak lifted the chained 0.5 to white — proves both hops auto-connected.
    expect(p).toBeGreaterThan(215);
  });
});
