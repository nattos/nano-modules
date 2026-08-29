import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

// util.triptych — three inputs side by side in a row.
//
// It has to be driven through a real sketch rather than the per-effect GPU
// harness, because two of its three inputs are SECONDARY texture inputs and
// only a wire can fill those.
//
// Every case here feeds the three panels flat colours, so "which panel got
// which input, and where does it start and stop" is readable straight off a
// pixel. The one case that uses a real picture is the three_walls layout at the
// bottom, which is what the card exists for.
describe('Triptych E2E', () => {
  jest.setTimeout(120000);

  const W = 300, H = 100;
  const MODULES = ['com.nano.core', 'com.nano.lights'];

  // Solid colours through two sidechannel buses into the side inputs, and a
  // third straight down the chain into the middle.
  const RED: [number, number, number] = [1, 0, 0];
  const GREEN: [number, number, number] = [0, 1, 0];
  const BLUE: [number, number, number] = [0, 0, 1];

  const colours = (params: Record<string, unknown>, wireSides = true): Sketch => ({
    anchor: null,
    wires: wireSides ? [
      { id: 'wl', src: { instanceKey: 'l@0', field: 'tex_out' },
        dest: { instanceKey: 'tp@0', field: 'left_in' } },
      { id: 'wr', src: { instanceKey: 'r@0', field: 'tex_out' },
        dest: { instanceKey: 'tp@0', field: 'right_in' } },
    ] : [],
    chain: [
      // The two side sources sit on the canvas-free tail of the chain; their
      // own image output is never consumed by the linear chain, only by wires.
      { type: 'module', module_type: 'source.solid_color', instance_key: 'l@0',
        params: { color: RED } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'r@0',
        params: { color: BLUE } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'm@0',
        params: { color: GREEN } },
      { type: 'module', module_type: 'util.triptych', instance_key: 'tp@0', params },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, unknown>, wireSides = true) =>
    runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: colours(params, wireSides) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });

  // Stretch, so each panel fills its third exactly and the thirds are the only
  // thing deciding where a colour starts and stops.
  const STRETCH = { fit_mode: 1 };

  // TRANSPARENT DOES NOT READ AS BLACK. Engine traces come back
  // checkerboard-composited, so an empty region is mid grey (~191), not dark —
  // "is it dim" would pass on a lit panel too. Every panel here is a pure
  // primary, so ACHROMATIC is the clean test for "nothing was drawn".
  const isEmpty = (p: { r: number; g: number; b: number }) =>
    Math.abs(p.r - p.g) < 24 && Math.abs(p.g - p.b) < 24 && Math.abs(p.r - p.b) < 24;

  it('lays the three inputs out left, middle, right', async () => {
    const r = await run('trip_order', STRETCH);
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // One sample from the middle of each third.
    f.expectPixelAt(Math.round(W / 6), H / 2, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(Math.round(W / 2), H / 2, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(Math.round(5 * W / 6), H / 2, { r: 0, g: 0, b: 255 }, 12);
  });

  it('the panels are exact thirds', async () => {
    const r = await run('trip_thirds', STRETCH);
    expect(r.success).toBe(true);
    const f = r.trace('out');
    const y = Math.round(H / 2);
    // Straddle both seams: one pixel either side must be the two neighbours.
    f.expectPixelAt(Math.round(W / 3) - 2, y, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(Math.round(W / 3) + 2, y, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(Math.round(2 * W / 3) - 2, y, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(Math.round(2 * W / 3) + 2, y, { r: 0, g: 0, b: 255 }, 12);
  });

  it('an unwired side stays transparent instead of repeating the middle',
     async () => {
    // The trap this guards: the shader has the middle bound in the side slots
    // (an unbound slot is not legal), so a missing "is it wired" flag would
    // silently show the middle picture three times.
    const r = await run('trip_unwired', STRETCH, false);
    expect(r.success).toBe(true);
    const f = r.trace('out');
    f.expectPixelAt(Math.round(W / 2), H / 2, { r: 0, g: 255, b: 0 }, 12);

    let sidePainted = 0;
    f.forEachPixel((p, x) => {
      const outer = x < W / 3 - 2 || x > (2 * W) / 3 + 2;
      if (outer && !isEmpty(p)) sidePainted++;
    });
    expect(sidePainted).toBeLessThan(40);
  });

  it('Fit letterboxes rather than distorting', async () => {
    // A third of a 300x100 frame is 100x100, and the sources are 300x100 — so
    // Fit shrinks each to 100x33 and leaves bars above and below. Stretch does
    // not. The middle column's top row tells them apart.
    const stretched = await run('trip_fit_off', { fit_mode: 1 });
    const fitted = await run('trip_fit_on', { fit_mode: 0 });
    expect(stretched.success && fitted.success).toBe(true);
    const x = Math.round(W / 2);
    stretched.trace('out').expectPixelAt(x, 4, { r: 0, g: 255, b: 0 }, 12);
    // Letterboxed: the top of the frame is nothing at all.
    expect(isEmpty(fitted.trace('out').pixelAt(x, 4))).toBe(true);
    // ...and the middle of the panel still carries the picture.
    fitted.trace('out').expectPixelAt(x, Math.round(H / 2), { r: 0, g: 255, b: 0 }, 12);
  });

  it('Gap cuts a divider at each seam without moving the panels', async () => {
    const r = await run('trip_gap', { ...STRETCH, gap: 0.12 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    const y = Math.round(H / 2);
    // The seam itself is cut away...
    expect(isEmpty(f.pixelAt(Math.round(W / 3), y))).toBe(true);
    // ...and each panel is still centred where it was.
    f.expectPixelAt(Math.round(W / 6), y, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(Math.round(W / 2), y, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(Math.round(5 * W / 6), y, { r: 0, g: 0, b: 255 }, 12);
  });

  // What the card is for. Three Walls' three outputs are three walls of one
  // room; laid out in this order they are the room, flat.
  it('lays out a Three Walls room', async () => {
    const sketch: Sketch = {
      anchor: null,
      wires: [
        { id: 'wl', src: { instanceKey: 'tw@0', field: 'left_out' },
          dest: { instanceKey: 'tp@0', field: 'left_in' } },
        { id: 'wr', src: { instanceKey: 'tw@0', field: 'right_out' },
          dest: { instanceKey: 'tp@0', field: 'right_in' } },
      ],
      chain: [
        { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
          params: { color: [0, 0, 0] } },
        { type: 'module', module_type: 'source.mesh.three_walls', instance_key: 'tw@0',
          params: { grain: 0, scanline: 0, chroma_bleed: 0,
                    // Frozen pose, and a size that puts the nearest frame onto
                    // the side walls while the others are still on the back.
                    resonate: 1, resonate_f0: 0, resonate_f1: 0, quad_size: 1.3 } },
        { type: 'module', module_type: 'util.triptych', instance_key: 'tp@0',
          params: STRETCH },
      ],
    } as Sketch;

    const r = await runEngineTest({
      width: 600, height: 200, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: 'trip_room', sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'trip_room' } }]},
      ],
      waitFrames: 25, captureTraceIds: ['out'], dumpName: 'trip_room',
    });
    expect(r.success).toBe(true);

    // All three panels carry light, and the two side ones are mirror images —
    // which is the check that they arrived in the right slots and neither got
    // dropped.
    const f = r.trace('out');
    const third = 600 / 3;
    const lit = [0, 0, 0];
    f.forEachPixel((p, x) => {
      const col = Math.min(2, Math.floor(x / third));
      if ((p.r + p.g + p.b) / 3 > 40) lit[col]++;
    });
    expect(lit[0]).toBeGreaterThan(50);
    expect(lit[1]).toBeGreaterThan(50);
    expect(lit[2]).toBeGreaterThan(50);
    expect(Math.abs(lit[0] - lit[2])).toBeLessThan(Math.max(lit[0], lit[2]) * 0.25);
  });
});

// The LED strip: a fourth input, UNDER the middle panel rather than beside it.
// The three columns are the three walls of one room; the strip is the same
// instrument read a second way, so it belongs beneath the picture it reads.
describe('Triptych LED strip', () => {
  jest.setTimeout(120000);

  const W = 300, H = 100;
  const MODULES = ['com.nano.core', 'com.nano.lights'];

  const RED: [number, number, number] = [1, 0, 0];
  const GREEN: [number, number, number] = [0, 1, 0];
  const BLUE: [number, number, number] = [0, 0, 1];
  // Chromatic and unlike any of the other three, so a pixel says which input
  // it came from on its own.
  const YELLOW: [number, number, number] = [1, 1, 0];

  const isEmpty = (p: { r: number; g: number; b: number }) =>
    Math.abs(p.r - p.g) < 24 && Math.abs(p.g - p.b) < 24 && Math.abs(p.r - p.b) < 24;

  const build = (params: Record<string, unknown>, wireLed = true): Sketch => ({
    anchor: null,
    wires: [
      { id: 'wl', src: { instanceKey: 'l@0', field: 'tex_out' },
        dest: { instanceKey: 'tp@0', field: 'left_in' } },
      { id: 'wr', src: { instanceKey: 'r@0', field: 'tex_out' },
        dest: { instanceKey: 'tp@0', field: 'right_in' } },
      ...(wireLed ? [{ id: 'wd', src: { instanceKey: 'd@0', field: 'tex_out' },
                       dest: { instanceKey: 'tp@0', field: 'led_in' } }] : []),
    ],
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'l@0',
        params: { color: RED } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'r@0',
        params: { color: BLUE } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'd@0',
        params: { color: YELLOW } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'm@0',
        params: { color: GREEN } },
      { type: 'module', module_type: 'util.triptych', instance_key: 'tp@0',
        params: { fit_mode: 1, ...params } },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, unknown>, wireLed = true) =>
    runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: build(params, wireLed) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });

  it('puts the strip under the middle panel, and only the middle', async () => {
    const r = await run('trip_led_under', { led_height: 0.25 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // The middle column: picture on top, strip below, split at 75% of the way
    // down.
    f.expectPixelAt(150, 30, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(150, 90, { r: 255, g: 255, b: 0 }, 12);
    // The two sides are walls of the room and do not split — they keep the
    // whole column, top to bottom.
    f.expectPixelAt(50, 30, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(50, 90, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(250, 30, { r: 0, g: 0, b: 255 }, 12);
    f.expectPixelAt(250, 90, { r: 0, g: 0, b: 255 }, 12);
  });

  it('LED Height moves the split and nothing else', async () => {
    const r = await run('trip_led_half', { led_height: 0.5 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    f.expectPixelAt(150, 40, { r: 0, g: 255, b: 0 }, 12);   // still picture
    f.expectPixelAt(150, 60, { r: 255, g: 255, b: 0 }, 12); // already strip
    // The columns did not move.
    f.expectPixelAt(50, 60, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(250, 60, { r: 0, g: 0, b: 255 }, 12);
  });

  it('an unwired strip leaves the middle panel whole', async () => {
    // Costing nothing when unused is the point: dropping this card on a chain
    // that has no LED map must look exactly as it did before there was one.
    const r = await run('trip_led_unwired', { led_height: 0.25 }, false);
    expect(r.success).toBe(true);
    const f = r.trace('out');
    f.expectPixelAt(150, 30, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(150, 90, { r: 0, g: 255, b: 0 }, 12);
  });

  it('Gap cuts the divider under the middle too', async () => {
    const r = await run('trip_led_gap', { led_height: 0.25, gap: 0.12 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // One knob, one kind of line: the seam under the picture is transparent
    // the way the seams between the columns are.
    expect(isEmpty(f.pixelAt(150, 75))).toBe(true);
    // ...and the two halves are still there either side of it.
    f.expectPixelAt(150, 30, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(150, 95, { r: 255, g: 255, b: 0 }, 12);
  });
});
