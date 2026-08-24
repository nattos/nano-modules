import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for `mod.shaper.slice` — one signal cut into N windowed outputs.
 *
 * The native twin (native/tests/test_mod_slice.cpp) reads the lanes straight
 * out of the modulation telemetry; here they have to become PIXELS, so each run
 * wires ONE lane into a brightness and reads the resulting grey. That means a
 * "does the chase actually chase" assertion is a comparison across runs: the
 * same lane, bright at its own window and dark at someone else's.
 *
 * The input comes from a dashboard knob, NOT a shaper. The math shapers are
 * modulation shapers, so the executor's auto-connect chains any two adjacent
 * ones and then into the next shaper's modulation channel — which here would be
 * the slice's own `input`. util.dashboard is a sketch-input-source, so nothing
 * auto-wires and the authored sweep stands. (This is the trap that ate the
 * first version of the switch's suite.)
 */
describe('mod.shaper.slice E2E', () => {
  jest.setTimeout(60000);

  /** Three lanes over thirds; `lane`'s output drives the frame's brightness. */
  const sliceSketch = (
    x: number, lane: number,
    extra: Record<string, unknown> = {},
  ): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'util.dashboard', instance_key: 'd1@0',
        params: { knob_0: x } },
      { type: 'module', module_type: 'mod.shaper.slice', instance_key: 'sl@0',
        params: {
          input_count: 3, beyond: 0,
          start_1: 0, end_1: 1 / 3,
          start_2: 1 / 3, end_2: 2 / 3,
          start_3: 2 / 3, end_3: 1,
          ...extra,
        } },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 0.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w_in', src: { instanceKey: 'd1@0', field: 'knob_0' },
        dest: { instanceKey: 'sl@0', field: 'input' }, combine: 'replace' },
      { id: 'w_out', src: { instanceKey: 'sl@0', field: `out_${lane}` },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, sketch: Sketch) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    commands: [{ type: 'createSketch', sketchId: id, sketch }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: `slice_${id}`,
  });

  /** The frame's grey level for one (input, lane) pair. */
  const grey = async (id: string, x: number, lane: number,
                      extra: Record<string, unknown> = {}) => {
    const r = await run(id, sliceSketch(x, lane, extra));
    expect(r.success).toBe(true);
    return r.trace('out').averageColor().r;
  };

  it('gates a lane on inside its own window and off outside it', async () => {
    // Lane 1 owns [0, 1/3). Lit at its midpoint, dark two thirds along.
    const inside = await grey('lane1_in', 1 / 6, 1);
    const outside = await grey('lane1_out', 5 / 6, 1);
    // eslint-disable-next-line no-console
    console.log('[slice gate] lane1 inside:', inside, ' outside:', outside);
    expect(inside).toBeGreaterThan(outside + 20);
  });

  it('reaches the LAST lane — a sweep to 1 lands somewhere', async () => {
    // The windows are half-open, so the top edge is the one place a lane can be
    // silently unreachable. Two lanes could never catch it; three can.
    const atEnd = await grey('lane3_end', 1.0, 3);
    const atStart = await grey('lane3_start', 1 / 6, 3);
    // eslint-disable-next-line no-console
    console.log('[slice sweep] lane3 at 1.0:', atEnd, ' at 1/6:', atStart);
    expect(atEnd).toBeGreaterThan(atStart + 20);
  });

  it('Hold keeps a passed lane up where Gate drops it', async () => {
    // Same lane, same input, past the end of its window: Gate reads 0, Hold
    // reads the curve's last value. The pair is the whole `beyond` selector.
    const gated = await grey('hold_gate', 5 / 6, 1, { beyond: 0 });
    const held = await grey('hold_hold', 5 / 6, 1, { beyond: 1 });
    // eslint-disable-next-line no-console
    console.log('[slice beyond] gate:', gated, ' hold:', held);
    expect(held).toBeGreaterThan(gated + 20);
  });

  it('applies a per-lane drawn curve to that lane only', async () => {
    // A curve peaking at the window's midpoint: (0,0) (0.5,1) (1,0). At the
    // midpoint an identity lane reads 0.5 and this one reads 1.
    const peak = '[0,0,0,0.5,1,0,1,0,0]';
    const shaped = await grey('curve_shaped', 0.5, 2, { curve_2: peak });
    const plain = await grey('curve_plain', 0.5, 2);
    // Lane 3 is untouched by lane 2's curve — same input, same reading either way.
    const neighbourShaped = await grey('curve_neighbour_a', 5 / 6, 3, { curve_2: peak });
    const neighbourPlain = await grey('curve_neighbour_b', 5 / 6, 3);
    // eslint-disable-next-line no-console
    console.log('[slice curve] shaped:', shaped, ' plain:', plain,
                ' neighbour:', neighbourShaped, neighbourPlain);
    expect(shaped).toBeGreaterThan(plain + 20);
    expect(Math.abs(neighbourShaped - neighbourPlain)).toBeLessThan(6);
  });
});
