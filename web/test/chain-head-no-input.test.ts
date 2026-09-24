import { runEngineTest } from './engine-test-helpers';

/**
 * A generator at the TOP of a chain, with nothing above it.
 *
 * Nearly every effect opens render() with
 *   auto in = gpu::Device::textureForField("tex_in");
 *   if (!in.valid() || !out.valid()) return;
 * so when the host supplies no input image (the effect IDE / playground with
 * no anchor, no test input and no global input) the FIRST stage used to be
 * handed the -1 sentinel and drew nothing at all — the effect only came alive
 * once any card was dropped above it. The executor now substitutes a cleared,
 * fully transparent intermediate for a missing chain input, which is what an
 * explicit "clear" stage above would have produced.
 *
 * debug.compute_probe (testonly) is the instrument: it carries that guard, and
 * its case 0 paints the whole frame an opaque green — unmistakable against the
 * checkerboard a transparent or missing frame composites to.
 */
describe('chain head with no input', () => {
  jest.setTimeout(60000);

  const run = (id: string, chain: any[]) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.testonly'],
    commands: [{ type: 'createSketch', sketchId: id,
                 sketch: { anchor: null, chain, wires: [] } as any }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  const PROBE = { type: 'module', module_type: 'debug.compute_probe',
                  instance_key: 'probe@0', params: { case: 0 } };
  const SOLID = { type: 'module', module_type: 'source.solid_color',
                  instance_key: 'src@0', params: { color: [0, 0, 0] } };

  it('renders an effect dropped at the head of an otherwise empty chain', async () => {
    const r = await run('head_alone', [PROBE]);
    expect(r.success).toBe(true);
    // Was the bare checkerboard before the executor cleared the head input.
    r.trace('out').expectUniformColor({ r: 0, g: 255, b: 0 }, 2);
  });

  it('matches what the same effect draws with a black card above it', async () => {
    const r = await run('head_below_solid', [SOLID, PROBE]);
    expect(r.success).toBe(true);
    r.trace('out').expectUniformColor({ r: 0, g: 255, b: 0 }, 2);
  });
});
