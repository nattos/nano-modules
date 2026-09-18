import { runEngineTest } from './engine-test-helpers';
import type { Frame } from './gpu-test-helpers';

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
 * source.mesh.three_planes is the instrument: it carries that guard and paints
 * a busy, unmistakable picture.
 */
describe('chain head with no input', () => {
  jest.setTimeout(60000);

  const run = (id: string, chain: any[]) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.core', 'com.nano.lights'],
    commands: [{ type: 'createSketch', sketchId: id,
                 sketch: { anchor: null, chain, wires: [] } as any }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  const TP = { type: 'module', module_type: 'source.mesh.three_planes',
               instance_key: 'tp@0' };
  const SOLID = { type: 'module', module_type: 'source.solid_color',
                  instance_key: 'src@0', params: { color: [0, 0, 0] } };

  /** Distinct colours in the frame — a blank (checkerboard-composited) trace
   *  has exactly the two checker greys. */
  const variety = (f: Frame) => {
    const seen = new Set<string>();
    f.forEachPixel(p => seen.add(`${p.r},${p.g},${p.b}`));
    return seen.size;
  };

  it('renders a generator dropped at the head of an otherwise empty chain', async () => {
    const r = await run('head_alone', [TP]);
    expect(r.success).toBe(true);
    // Was 2 (the bare checkerboard) before the executor cleared the head input.
    expect(variety(r.trace('out'))).toBeGreaterThan(100);
  });

  it('matches what the same effect draws with a black card above it', async () => {
    const r = await run('head_below_solid', [SOLID, TP]);
    expect(r.success).toBe(true);
    expect(variety(r.trace('out'))).toBeGreaterThan(100);
  });
});
