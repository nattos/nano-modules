import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for CHAINING shapers: a shaper directly after another shaper auto-connects
 * too (not only after a source). Probe: white solid → mod.source.lfo →
 * mod.shaper.smooth → mod.shaper.envelope → brightness_contrast, with ONLY envelope.output
 * wired into bc.brightness. The lfo→smooth and smooth→envelope hops auto-connect,
 * each carrying the upstream RAW value (`magnitude:"absolute"`).
 *
 * We drive a SQUARE lfo (waveform 1) at rate 0 → deterministic raw +1 (≠ the
 * shaper inputs' default 0). With an identity envelope, +1 flows lfo(+1) →
 * smooth(+1) → envelope(1) → brightness 1 → white. If EITHER hop didn't
 * auto-connect, the downstream input stays 0 → output 0 → black.
 */
describe('modulation shaper chaining E2E', () => {
  jest.setTimeout(40000);

  const build = (id: string, curve: string): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      // Square wave @ rate 0 → deterministic raw output of +1.
      { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
        params: { rate: 0.0, amplitude: 1.0, waveform: 1 } },
      { type: 'module', module_type: 'mod.shaper.smooth', instance_key: 'sm@0',
        params: { duration: 0.0 } },
      { type: 'module', module_type: 'mod.shaper.envelope', instance_key: 'env@0',
        params: { curve } },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    // Only the final hop is drawn; lfo→smooth and smooth→envelope auto-connect.
    wires: [
      { id: 'w1', src: { instanceKey: 'env@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, curve: string) => runEngineTest({
    width: 64, height: 64,
    modules: ['source.solid_color', 'mod.source.lfo', 'mod.shaper.smooth', 'mod.shaper.envelope', 'color.tone.brightness_contrast'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(id, curve) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 30,   // generous: the value mirrors one hop per frame
    dumpName: id,
  });

  it('a value flows through a chain of auto-connected shapers', async () => {
    // Identity envelope: raw +1 passes lfo→smooth→envelope unchanged → white.
    const ident = await run('chain_ident', '[0,0,0, 1,1,0]');
    // Half envelope: maps input 1 → 0.5, so the chained +1 lands on ~gray. Proves
    // the value actually flowed THROUGH the curve (not merely that a wire exists).
    const half = await run('chain_half', '[0,0,0, 1,0.5,0]');
    expect(ident.success && half.success).toBe(true);

    const i = ident.trace('out').averageColor().r;
    const h = half.trace('out').averageColor().r;
    // Identity → +1 → white; if EITHER hop hadn't connected this would be black.
    expect(i).toBeGreaterThan(215);
    // The curve lowered the chained +1 to ~0.5 gray — distinctly below white.
    expect(h).toBeLessThan(i - 60);
    expect(h).toBeGreaterThan(80);
  });
});
