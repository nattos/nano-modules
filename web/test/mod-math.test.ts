import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the split-out math shapers (mod.shaper.add / subtract / average /
 * multiply / ...) — the per-op siblings of mod.shaper.combine, with a variable
 * input count instead of an op selector.
 *
 * Probe chain: white solid -> <math node> -> brightness_contrast, with
 * node.output wired into bc.brightness (combine:'replace', unsigned -> the
 * value passes straight into [0,1]), so bc paints gray(value*255). bc's
 * contrast is -0.5, so the 0.5 pivot is EXACT (gray 128) while other values are
 * pulled toward mid — every absolute check below is anchored at 0.5 and
 * everything else is relative. Same approach as mod-combine/mod-remap.
 *
 * Inputs are authored as params (source.solid_color is not a modulation source,
 * so the shaper auto-connect never fires and the sliders stand). Inputs left
 * unset rest at the op's identity (mod_math_ops::restingInput), which is what
 * the last test pins.
 */
describe('mod.shaper.* math nodes E2E', () => {
  jest.setTimeout(30000);

  const build = (moduleType: string, params: Record<string, number>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: moduleType, instance_key: 'm@0', params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'm@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, moduleType: string, params: Record<string, number>) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(moduleType, params) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  it('add sums every active input', async () => {
    // 0.2 + 0.2 + 0.1 = 0.5 -> exact gray pivot.
    const r = await run('m_add3', 'mod.shaper.add',
      { input_count: 3, input_1: 0.2, input_2: 0.2, input_3: 0.1 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('input_count gates the fold — a 4th input only counts once the count says so', async () => {
    const params = { input_1: 0.2, input_2: 0.2, input_3: 0.1, input_4: 0.5 };
    // count 3 ignores input_4 entirely -> 0.5 -> pivot.
    const three = await run('m_gate3', 'mod.shaper.add', { ...params, input_count: 3 });
    // count 4 folds it in -> 1.0 -> clamps bright.
    const four = await run('m_gate4', 'mod.shaper.add', { ...params, input_count: 4 });
    expect(three.success && four.success).toBe(true);
    three.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    expect(four.trace('out').averageColor().r)
      .toBeGreaterThan(three.trace('out').averageColor().r + 30);
  });

  it('subtract folds LEFT to right: in1 - in2 - in3', async () => {
    // 0.9 - 0.2 - 0.2 = 0.5 -> exact pivot. A right fold (0.9 - (0.2 - 0.2))
    // would give 0.9, and any non-chaining 2-input reading would give 0.7.
    const r = await run('m_sub3', 'mod.shaper.subtract',
      { input_count: 3, input_1: 0.9, input_2: 0.2, input_3: 0.2 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });

  it('average is the TRUE mean, not a fold of pairwise means', async () => {
    // inputs 0,0,0,1 over 4 inputs. Mean = 0.25 (dark).
    // A left fold would be avg(avg(avg(0,0),0),1) = 0.5 — landing EXACTLY on the
    // gray pivot — so "clearly below the pivot" is a decisive discriminator.
    const r = await run('m_avg4', 'mod.shaper.average',
      { input_count: 4, input_1: 0.0, input_2: 0.0, input_3: 0.0, input_4: 1.0 });
    expect(r.success).toBe(true);
    // Sanity anchor: a genuine 0.5 renders as 128.
    const pivot = await run('m_avg_pivot', 'mod.shaper.average',
      { input_count: 2, input_1: 0.5, input_2: 0.5 });
    expect(pivot.success).toBe(true);
    pivot.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    expect(r.trace('out').averageColor().r)
      .toBeLessThan(pivot.trace('out').averageColor().r - 20);
  });

  it('unwired inputs rest at the op identity — raising multiply\'s count changes nothing', async () => {
    // multiply rests every input at 1, so inputs 3..6 are no-ops. Both runs must
    // land on 0.5 * 1.0 = 0.5 -> the exact pivot. (Combine rests at 0, which
    // would have collapsed the product to zero — this is the behaviour change.)
    const two = await run('m_mul2', 'mod.shaper.multiply',
      { input_count: 2, input_1: 0.5, input_2: 1.0 });
    const six = await run('m_mul6', 'mod.shaper.multiply',
      { input_count: 6, input_1: 0.5, input_2: 1.0 });
    expect(two.success && six.success).toBe(true);
    two.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
    six.trace('out').expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 15);
  });
});
