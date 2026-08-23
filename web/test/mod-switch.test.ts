import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for `mod.shaper.switch` — ONE card that switches floats, colours and
 * video, rather than three near-identical cards.
 *
 * The point of the suite is that the SAME module id appears in every case
 * below carrying a different data class each time. That is what the whole
 * raw → any → vec sequence was for; if these ever have to split into
 * per-type module ids, the design failed.
 *
 * `select` sweeps 0..1 across however many cases exist (the effect scales by its
 * live count), so the assertions drive it to the middle of a case's band rather
 * than to a boundary.
 */
describe('mod.shaper.switch E2E', () => {
  jest.setTimeout(45000);

  // --- float cases: two dashboard knobs holding distinct constants ---------
  //
  // Dashboard knobs, NOT mod.shaper.add. The math shapers are modulation
  // SHAPERS, so the executor's auto-connect chains any two adjacent ones
  // together and then into the next shaper's modulation channel — which here is
  // the switch's own `select`. That silently overwrote both the second constant
  // AND the selector, so every case returned the same value and the suite
  // looked like a switch that doesn't switch. util.dashboard is a
  // sketch-input-source, not a modulation producer, so nothing auto-wires.
  const floatSketch = (select: number): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'util.dashboard', instance_key: 'd1@0',
        params: { knob_0: 0.2 } },
      { type: 'module', module_type: 'util.dashboard', instance_key: 'd2@0',
        params: { knob_0: 0.9 } },
      { type: 'module', module_type: 'mod.shaper.switch', instance_key: 'sw@0',
        params: { select, input_count: 2 } },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'd1@0', field: 'knob_0' },
        dest: { instanceKey: 'sw@0', field: 'case_1' }, combine: 'replace' },
      { id: 'w2', src: { instanceKey: 'd2@0', field: 'knob_0' },
        dest: { instanceKey: 'sw@0', field: 'case_2' }, combine: 'replace' },
      { id: 'w3', src: { instanceKey: 'sw@0', field: 'output' },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  // --- colour cases: two Colour swatches ----------------------------------
  const colorSketch = (select: number): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'mod.source.color', instance_key: 'c1@0',
        params: { color: [0.9, 0.1, 0.1] } },
      { type: 'module', module_type: 'mod.source.color', instance_key: 'c2@0',
        params: { color: [0.1, 0.1, 0.9] } },
      { type: 'module', module_type: 'mod.shaper.switch', instance_key: 'sw@0',
        params: { select, input_count: 2 } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'fill@0',
        params: { color: [0.0, 0.0, 0.0] } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'c1@0', field: 'color' },
        dest: { instanceKey: 'sw@0', field: 'case_1' }, combine: 'replace' },
      { id: 'w2', src: { instanceKey: 'c2@0', field: 'color' },
        dest: { instanceKey: 'sw@0', field: 'case_2' }, combine: 'replace' },
      { id: 'w3', src: { instanceKey: 'sw@0', field: 'output' },
        dest: { instanceKey: 'fill@0', field: 'color' }, combine: 'replace' },
    ],
  } as Sketch);

  // --- texture cases: two solid fills, switched as IMAGES -------------------
  // The switch aliases the selected handle rather than blitting, so this also
  // covers that the aliased texture is what the consumer actually reads.
  const textureSketch = (select: number): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 't1@0',
        params: { color: [0.9, 0.1, 0.1] } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 't2@0',
        params: { color: [0.1, 0.1, 0.9] } },
      { type: 'module', module_type: 'mod.shaper.switch', instance_key: 'sw@0',
        params: { select, input_count: 2 } },
      // opacity 1 = show B outright, so the frame IS the switched texture.
      // B is the numeric slot '1' — the shape every other texture-wire test
      // uses; `tex_in` is the LINEAR chain feed and a wire there is overwritten.
      { type: 'module', module_type: 'composite.blend', instance_key: 'bl@0',
        params: { opacity: 1.0, mode: 0 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 't1@0', field: 'tex_out' },
        dest: { instanceKey: 'sw@0', field: 'case_1' }, combine: 'replace' },
      { id: 'w2', src: { instanceKey: 't2@0', field: 'tex_out' },
        dest: { instanceKey: 'sw@0', field: 'case_2' }, combine: 'replace' },
      { id: 'w3', src: { instanceKey: 'sw@0', field: 'output' },
        dest: { instanceKey: 'bl@0', field: '1' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, sketch: Sketch) => runEngineTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    commands: [{ type: 'createSketch', sketchId: id, sketch }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: `switch_${id}`,
  });

  it('switches FLOATS between its cases', async () => {
    // brightness 0.2 vs 0.9 with contrast -0.5 → a clearly darker vs lighter
    // grey. Compared against each other, not against absolutes, so the exact
    // tone curve doesn't matter.
    const lo = await run('float_lo', floatSketch(0.25));   // case 1
    const hi = await run('float_hi', floatSketch(0.75));   // case 2
    expect(lo.success && hi.success).toBe(true);
    const a = lo.trace('out').averageColor();
    const b = hi.trace('out').averageColor();
    // eslint-disable-next-line no-console
    console.log('[switch float] case1 grey:', a.r, ' case2 grey:', b.r);
    expect(b.r).toBeGreaterThan(a.r + 20);
  });

  it('switches COLOURS between its cases', async () => {
    const one = await run('color_1', colorSketch(0.25));
    const two = await run('color_2', colorSketch(0.75));
    expect(one.success && two.success).toBe(true);
    const a = one.trace('out').averageColor();
    const b = two.trace('out').averageColor();
    // eslint-disable-next-line no-console
    console.log('[switch colour] case1:', a.r, a.g, a.b, ' case2:', b.r, b.g, b.b);
    expect(a.r).toBeGreaterThan(a.b);   // case 1 is red-dominant
    expect(b.b).toBeGreaterThan(b.r);   // case 2 is blue-dominant
  });

  it('switches TEXTURES between its cases, by aliasing the handle', async () => {
    const one = await run('tex_1', textureSketch(0.25));
    const two = await run('tex_2', textureSketch(0.75));
    expect(one.success && two.success).toBe(true);
    const a = one.trace('out').averageColor();
    const b = two.trace('out').averageColor();
    // eslint-disable-next-line no-console
    console.log('[switch texture] case1:', a.r, a.g, a.b, ' case2:', b.r, b.g, b.b);
    expect(a.r).toBeGreaterThan(a.b);
    expect(b.b).toBeGreaterThan(b.r);
  });

  it('spans every case as select sweeps 0..1, whatever the count', async () => {
    // Three cases: the sweep must reach the LAST one. The index is
    // floor(select * count), so a hardcoded [0,7] selector range (or an
    // off-by-one clamp) would leave case 3 unreachable — which a two-case test
    // cannot detect.
    const three = (select: number): Sketch => {
      const s = colorSketch(select);
      s.chain.splice(2, 0, {
        type: 'module', module_type: 'mod.source.color', instance_key: 'c3@0',
        params: { color: [0.1, 0.9, 0.1] },
      } as any);
      (s.chain[3] as any).params.input_count = 3;
      s.wires!.push({
        id: 'w4', src: { instanceKey: 'c3@0', field: 'color' },
        dest: { instanceKey: 'sw@0', field: 'case_3' }, combine: 'replace',
      });
      return s;
    };
    const last = await run('sweep_last', three(0.95));
    expect(last.success).toBe(true);
    const c = last.trace('out').averageColor();
    // eslint-disable-next-line no-console
    console.log('[switch sweep] select 0.95 of 3:', c.r, c.g, c.b);
    expect(c.g).toBeGreaterThan(c.r);   // the third case is green-dominant
    expect(c.g).toBeGreaterThan(c.b);
  });
});
