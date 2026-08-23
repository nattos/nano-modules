import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for VEC (colour) wires on the web backend.
 *
 * Before this, no vec value could cross a wire at all — rail lowering routed
 * float / texture / object|array and dropped everything else silently, while
 * the editor still drew the port and labelled its chip "vec3".
 *
 * The native twin is native/tests/test_vec_rail.cpp. Both hosts run the SAME
 * executor.wasm, so the lowering and the rail plumbing are shared — what is
 * genuinely different here, and the reason this file exists, is the host import
 * behind it: `published_array` is hand-written per host (executor-host.ts here,
 * executor_host.cpp natively). A vec wire could work perfectly on one and be
 * dead on the other.
 *
 * mod.source.color is the producer (the only vec-rail source in the tree —
 * every other vec/rgb field is an input) and source.solid_color the consumer.
 * The three channels are deliberately distinct so a swapped- or
 * broadcast-component bug can't pass as "coloured".
 */
describe('vec (colour) wires E2E', () => {
  jest.setTimeout(30000);

  const build = (wired: boolean): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'mod.source.color', instance_key: 'col@0',
        params: { color: [0.2, 0.4, 0.8] } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'fill@0',
        params: { color: [0.0, 0.0, 0.0] } },
    ],
    wires: wired ? [
      { id: 'w1', src: { instanceKey: 'col@0', field: 'color' },
        dest: { instanceKey: 'fill@0', field: 'color' }, combine: 'replace' },
    ] : [],
  } as Sketch);

  const run = (id: string, wired: boolean) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(wired) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: `vec_rail_${id}`,
  });

  it('carries a colour from the swatch to the consumer, component-for-component', async () => {
    const res = await run('wired', true);
    expect(res.success).toBe(true);
    const f = res.trace('out');

    const c = f.averageColor();
    // eslint-disable-next-line no-console
    console.log('[vec wired] mean rgb:', c.r, c.g, c.b);

    // 0.2/0.4/0.8 → roughly 51/102/204. Wide bands (the pipeline may apply
    // transfer curves) — the load-bearing assertion is that the channels are
    // DISTINCT and ordered, which is what pins component order.
    expect(c.r).toBeGreaterThan(20);  expect(c.r).toBeLessThan(90);
    expect(c.g).toBeGreaterThan(70);  expect(c.g).toBeLessThan(140);
    expect(c.b).toBeGreaterThan(160); expect(c.b).toBeLessThan(245);
    expect(c.r).toBeLessThan(c.g);
    expect(c.g).toBeLessThan(c.b);
  });

  it('leaves the consumer on its own colour when nothing is wired', async () => {
    // The control. Without it, "the wire worked" is indistinguishable from
    // "solid_color was that colour anyway".
    const res = await run('unwired', false);
    expect(res.success).toBe(true);
    const c = res.trace('out').averageColor();
    // eslint-disable-next-line no-console
    console.log('[vec unwired] mean rgb:', c.r, c.g, c.b);
    expect(c.r).toBeLessThan(12);
    expect(c.g).toBeLessThan(12);
    expect(c.b).toBeLessThan(12);
  });
});
