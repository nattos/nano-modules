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

// The LED strip: a fourth input, UNDER the middle third rather than beside it.
// The three columns are the three walls of one room; the strip is the same
// instrument read a second way, so it belongs beneath the picture it reads.
//
// Its height comes off the WHOLE FRAME. The row of three has to stay a row —
// same top, same bottom — so most of what is here is checking that the strip
// never steps the middle panel out of line with the walls either side of it.
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

  it('keeps the three panels an aligned row and puts the strip below it',
     async () => {
    const r = await run('trip_led_under', { led_height: 0.25 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // The row runs to 75% of the way down, and all three panels run with it —
    // same top, same bottom. A middle panel that gave up the strip on its own
    // would step the room at both seams, which is the one thing a measuring
    // surface must not do.
    for (const [x, want] of [[50, { r: 255, g: 0, b: 0 }],
                             [150, { r: 0, g: 255, b: 0 }],
                             [250, { r: 0, g: 0, b: 255 }]] as const) {
      f.expectPixelAt(x, 5, want, 12);    // top of the row
      f.expectPixelAt(x, 70, want, 12);   // and still going at the bottom of it
    }
    // Below the row: the strip under the middle third, and nothing either side.
    f.expectPixelAt(150, 90, { r: 255, g: 255, b: 0 }, 12);
    expect(isEmpty(f.pixelAt(50, 90))).toBe(true);
    expect(isEmpty(f.pixelAt(250, 90))).toBe(true);
  });

  it('LED Height moves the row\'s bottom edge, for all three at once',
     async () => {
    const r = await run('trip_led_half', { led_height: 0.5 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // Half the frame now, so the row ends at mid-height — and it ends there
    // for the walls exactly as it does for the picture.
    f.expectPixelAt(50, 40, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(150, 40, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(250, 40, { r: 0, g: 0, b: 255 }, 12);
    f.expectPixelAt(150, 60, { r: 255, g: 255, b: 0 }, 12);
    expect(isEmpty(f.pixelAt(50, 60))).toBe(true);
    expect(isEmpty(f.pixelAt(250, 60))).toBe(true);
  });

  it('an unwired strip leaves the row the whole frame', async () => {
    // Costing nothing when unused is the point: dropping this card on a chain
    // that has no LED map must look exactly as it did before there was one.
    const r = await run('trip_led_unwired', { led_height: 0.25 }, false);
    expect(r.success).toBe(true);
    const f = r.trace('out');
    f.expectPixelAt(150, 30, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(150, 90, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(50, 90, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(250, 90, { r: 0, g: 0, b: 255 }, 12);
  });

  it('Gap cuts the divider under the whole row', async () => {
    const r = await run('trip_led_gap', { led_height: 0.25, gap: 0.12 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // One knob, one kind of line: the seam under the row is transparent the
    // way the seams between the columns are — and it runs the full width,
    // because the row it closes off runs the full width.
    expect(isEmpty(f.pixelAt(150, 75))).toBe(true);
    expect(isEmpty(f.pixelAt(50, 75))).toBe(true);
    expect(isEmpty(f.pixelAt(250, 75))).toBe(true);
    // ...and what it separates is still there either side of it.
    f.expectPixelAt(150, 30, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(150, 95, { r: 255, g: 255, b: 0 }, 12);
  });
});

// Middle Size and Perspective: the flat row bent into the room it is a picture
// of. The back wall grows past its third and the two sides splay out into
// trapezoids — short where they meet it, full height at the frame edges.
describe('Triptych room', () => {
  jest.setTimeout(120000);

  const W = 300, H = 100;
  const MODULES = ['com.nano.core', 'com.nano.lights'];

  const RED: [number, number, number] = [1, 0, 0];
  const GREEN: [number, number, number] = [0, 1, 0];
  const BLUE: [number, number, number] = [0, 0, 1];

  const isEmpty = (p: { r: number; g: number; b: number }) =>
    Math.abs(p.r - p.g) < 24 && Math.abs(p.g - p.b) < 24 && Math.abs(p.r - p.b) < 24;

  // `leftIsRamp` swaps the left source for a white-to-black horizontal ramp,
  // which turns the left panel into a ruler: the luma at a pixel says exactly
  // how far along the wall it is reading, which is the only way to see the
  // difference between a corridor and a stretched rectangle.
  const build = (params: Record<string, unknown>, leftIsRamp = false): Sketch => ({
    anchor: null,
    wires: [
      { id: 'wl', src: { instanceKey: 'l@0', field: 'tex_out' },
        dest: { instanceKey: 'tp@0', field: 'left_in' } },
      { id: 'wr', src: { instanceKey: 'r@0', field: 'tex_out' },
        dest: { instanceKey: 'tp@0', field: 'right_in' } },
    ],
    chain: [
      leftIsRamp
        // Defaults are exactly the ramp we want: angle 0 is left-to-right,
        // softness 1 is the full linear sweep, white into black.
        ? { type: 'module', module_type: 'source.gradient', instance_key: 'l@0',
            params: {} }
        : { type: 'module', module_type: 'source.solid_color', instance_key: 'l@0',
            params: { color: RED } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'r@0',
        params: { color: BLUE } },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'm@0',
        params: { color: GREEN } },
      { type: 'module', module_type: 'util.triptych', instance_key: 'tp@0',
        params: { fit_mode: 1, ...params } },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, unknown>, leftIsRamp = false) =>
    runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: build(params, leftIsRamp) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });

  it('Middle Size widens the back wall and the sides give up the room',
     async () => {
    // 1.8 thirds is 60% of the width, so the seams move from 100 and 200 in to
    // 60 and 240.
    const r = await run('trip_room_wide', { mid_scale: 1.8 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    f.expectPixelAt(30, 50, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(270, 50, { r: 0, g: 0, b: 255 }, 12);
    // 90 and 210 were the sides at an exact third and are the back wall now.
    f.expectPixelAt(90, 50, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(210, 50, { r: 0, g: 255, b: 0 }, 12);
    // ...and it is still centred: the seams moved by the same amount.
    f.expectPixelAt(70, 50, { r: 0, g: 255, b: 0 }, 12);
    f.expectPixelAt(230, 50, { r: 0, g: 255, b: 0 }, 12);
  });

  it('Perspective splays the sides and pulls the back wall down', async () => {
    // At a third wide, full perspective puts the frame edge three times the
    // height of the seam — that ratio is the geometry, not a taste. So the
    // back wall covers the middle third of the height and the walls open out
    // to the full frame at the edges.
    const r = await run('trip_room_persp', { mid_scale: 1, perspective: 1 });
    expect(r.success).toBe(true);
    const f = r.trace('out');

    f.expectPixelAt(150, 50, { r: 0, g: 255, b: 0 }, 12);
    // Above and below the back wall is the room's ceiling and floor, which we
    // do not have — so it is nothing, not a stretched picture.
    expect(isEmpty(f.pixelAt(150, 5))).toBe(true);
    expect(isEmpty(f.pixelAt(150, 95))).toBe(true);

    // Hard against the seam a wall is as short as the back wall...
    f.expectPixelAt(95, 50, { r: 255, g: 0, b: 0 }, 12);
    expect(isEmpty(f.pixelAt(95, 5))).toBe(true);
    // ...and out at the frame edge it is the full height of the frame.
    f.expectPixelAt(5, 5, { r: 255, g: 0, b: 0 }, 12);
    f.expectPixelAt(5, 95, { r: 255, g: 0, b: 0 }, 12);

    // The right wall mirrors it.
    expect(isEmpty(f.pixelAt(205, 5))).toBe(true);
    f.expectPixelAt(295, 5, { r: 0, g: 0, b: 255 }, 12);
    f.expectPixelAt(295, 95, { r: 0, g: 0, b: 255 }, 12);
  });

  it('Perspective 0 is the flat row, whatever the middle is doing', async () => {
    const r = await run('trip_room_flat', { mid_scale: 1.8, perspective: 0 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // Every panel full height, top to bottom — a wider middle on its own must
    // not tilt anything.
    for (const [x, want] of [[30, { r: 255, g: 0, b: 0 }],
                             [150, { r: 0, g: 255, b: 0 }],
                             [270, { r: 0, g: 0, b: 255 }]] as const) {
      f.expectPixelAt(x, 3, want, 12);
      f.expectPixelAt(x, 97, want, 12);
    }
  });

  it('samples the sides as a corridor rather than stretching one', async () => {
    // The left source is a white-to-black ramp, so luma reads out how far
    // along the wall a pixel is: 255 * (distance from the far end).
    //
    // Halfway across the panel on screen is NOT halfway along the wall. Screen
    // position interpolates linearly, the wall's own coordinate does not, and
    // that difference is the entire reason a corridor's far half looks
    // compressed. At a third wide and full perspective the screen midpoint sits
    // three quarters of the way along.
    const flat = await run('trip_room_ramp_flat', { perspective: 0 }, true);
    const deep = await run('trip_room_ramp_deep', { perspective: 1 }, true);
    expect(flat.success && deep.success).toBe(true);

    // x = 50 is the middle of the left panel; y = 50 is inside the wall in
    // both cases.
    const flatMid = flat.trace('out').pixelAt(50, 50);
    const deepMid = deep.trace('out').pixelAt(50, 50);
    expect(flatMid.r).toBeGreaterThan(114);   // 255 * 0.50
    expect(flatMid.r).toBeLessThan(142);
    expect(deepMid.r).toBeGreaterThan(177);   // 255 * 0.75
    expect(deepMid.r).toBeLessThan(205);

    // Both ends still land where they belong, so the compression is a
    // reparameterisation and not a slide: the far end is at the seam.
    expect(deep.trace('out').pixelAt(97, 50).r).toBeLessThan(30);
    expect(deep.trace('out').pixelAt(3, 50).r).toBeGreaterThan(225);
  });
});
