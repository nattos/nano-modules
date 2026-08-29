import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * `left_out` / `right_out` — the impact light `source.mesh.three_planes` throws
 * onto the walls of the room it stands in.
 *
 * A LIGHT MODEL, not a second picture of the tower: nothing in the pass draws a
 * quad. Each floor is FOUR TUBES in the room, turned by the orbit, so what
 * lands depends on how the ring is facing: square on, the near edge does all
 * the work and lays a flat bar; turned off it, one corner is nearest and the
 * pool leans that way. Everything below is checking that the SHAPE is the one
 * the geometry gives rather than an authored gradient, because that is the
 * whole difference between light on a wall and bad lighting in an old game.
 *
 * Most cases pin the orbit SQUARE ON, where the shape is simple enough to make
 * claims about. The orbit's own effect gets its own cases at the bottom.
 *
 * Engine harness, because these are secondary texture outputs and only a wire
 * can reach one (chroma_wave's sidechannel trick). That makes them WebGPU
 * only; the Metal side of the same pass is pinned in
 * native/tests/test_effect_render.cpp.
 *
 * The GLINTS also light the walls, and because they cross the room rather than
 * the picture they reach the two walls at different moments — which is the one
 * thing that makes the two outputs different pictures. That is deliberately NOT
 * asserted here: a glint is a particle born from knob MOTION, so a wall-clock
 * engine run cannot hold one still. What is asserted is the symmetry it breaks
 * — with the glimmer off, the two walls agree exactly.
 */
describe('Three Planes impact light', () => {
  jest.setTimeout(120000);

  const W = 480, H = 270;
  const MODULES = ['com.nano.core', 'com.nano.lights'];

  // A floor's pool lands at the height that floor is DRAWN at, so the row it
  // occupies is the picture's own: model height through the elevation squash
  // and the zoom, into cover-square, into pixels. That is what keeps the three
  // outputs one room when they are laid out side by side.
  const SPACING = 0.42, ZOOM = 0.55;
  const ELEV_COS = Math.cos((35.264389682754654 * Math.PI) / 180);
  const ASPECT_Y = Math.max(W, H) / (2 * H);
  const rowOfFloor = (i: number, elevCos = ELEV_COS) =>
    Math.round((0.5 - (i - 1) * SPACING * elevCos * ZOOM * ASPECT_Y) * H);

  const luma = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3;
  // How bright the light IS, rather than how bright a grey of the same value
  // would be. The floors here are pure primaries, so a luma reading is a third
  // of the level and every threshold written against it would be a lie.
  const level = (p: { r: number; g: number; b: number }) =>
    Math.max(p.r, Math.max(p.g, p.b));

  const build = (field: string, params: Record<string, unknown>,
                 wired = true): Sketch => ({
    anchor: null,
    wires: wired ? [{ id: 'ww', src: { instanceKey: 'tp@0', field },
                      dest: { instanceKey: 'send@0', field: 'send_in' } }] : [],
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
        params: { color: [0, 0, 0] } },
      { type: 'module', module_type: 'source.mesh.three_planes', instance_key: 'tp@0',
        params: {
          grain: 0, scanline: 0, chroma_bleed: 0,
          // A primary per floor, so a bar in the wrong place is a different
          // colour rather than a near miss.
          plane1_color: [1, 0, 0], plane2_color: [0, 1, 0], plane3_color: [0, 0, 1],
          plane1_emission: 1, plane2_emission: 1, plane3_emission: 1,
          // No glimmer: glints are particles born from knob motion, and a
          // wall-clock run cannot hold one still.
          glimmer_gain: 0, glimmer_chaos: 0,
          // Square on unless a case says otherwise — the ring's near edge then
          // faces the wall outright and lays the simple bar these claims are
          // about. (The card's own default is 45, a corner pointing at each
          // wall, which is a different picture entirely.)
          orbit_azimuth: 0,
          ...params,
        } },
      { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send@0',
        params: { channel: 3 } },
      { type: 'module', module_type: 'util.sidechannel_in', instance_key: 'recv@0',
        params: { channel: 3 } },
    ],
  } as Sketch);

  const view = (id: string, field: string, params: Record<string, unknown>,
                wired = true) =>
    runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: build(field, params, wired) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });

  it('lays one bar per floor, at its own height and in its own colour',
     async () => {
    const r = await view('tpw_floors', 'left_out', {});
    expect(r.success).toBe(true);
    const f = r.trace('out');
    const x = W / 2;

    const bottom = f.pixelAt(x, rowOfFloor(0));
    const middle = f.pixelAt(x, rowOfFloor(1));
    const top = f.pixelAt(x, rowOfFloor(2));

    // Each floor's own colour dominates at its own height. The bottom floor is
    // LOW on the wall, which is the one thing a sign error would flip.
    expect(bottom.r).toBeGreaterThan(bottom.g + 40);
    expect(bottom.r).toBeGreaterThan(bottom.b + 40);
    expect(middle.g).toBeGreaterThan(middle.r + 40);
    expect(middle.g).toBeGreaterThan(middle.b + 40);
    expect(top.b).toBeGreaterThan(top.r + 40);
    expect(top.b).toBeGreaterThan(top.g + 40);
  });

  it('a dark floor throws nothing', async () => {
    const r = await view('tpw_dark', 'left_out', { plane2_emission: 0 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    const x = W / 2;
    // The middle band is now only what its neighbours' bounce puts there...
    expect(luma(f.pixelAt(x, rowOfFloor(1))))
      .toBeLessThan(luma(f.pixelAt(x, rowOfFloor(0))) * 0.5);
    // ...and no green survives in it, so nothing of that floor is left.
    const mid = f.pixelAt(x, rowOfFloor(1));
    expect(mid.g).toBeLessThan(mid.r + 10);
  });

  it('lays a bar with hot ends across the ring, and nothing past it',
     async () => {
    // The shape the four tubes give, and none of it is drawn. Square on, the
    // near edge is at one distance along its whole length, so the pool is FLAT
    // across the middle — an emitter with width, not a blob centred on a point.
    // At the ends the two edges running away from the wall come close enough to
    // add, so the bar brightens into its corners before it goes. That structure
    // is the difference between this and a gradient.
    const r = await view('tpw_bar', 'left_out', {});
    expect(r.success).toBe(true);
    const f = r.trace('out');
    const y = rowOfFloor(2);

    // The ring is 0.62 stack-units wide at 0.55 zoom, so its ends land about
    // 82px either side of centre.
    const mid = level(f.pixelAt(W / 2, y));
    for (const x of [W / 2 - 40, W / 2 + 40])
      expect(Math.abs(level(f.pixelAt(x, y)) - mid)).toBeLessThan(mid * 0.08);

    // The corners, hotter than the middle and on both sides of it.
    for (const x of [W / 2 - 80, W / 2 + 80])
      expect(level(f.pixelAt(x, y))).toBeGreaterThan(mid * 1.15);

    // ...and then it goes. Out at the edge of the wall there is bounce and
    // little else.
    expect(level(f.pixelAt(12, y))).toBeLessThan(mid * 0.15);
  });

  it('Distance is the size of the light, not a softness', async () => {
    // Half brightness lands about two thirds of a gap out, so the pool's own
    // height IS the distance to the wall. Nothing else in the pass sets it.
    const halfHeight = (f: any, y0: number) => {
      const peak = luma(f.pixelAt(W / 2, y0));
      for (let d = 1; d < H / 2; d++)
        if (luma(f.pixelAt(W / 2, y0 - d)) < peak * 0.5) return d;
      return H / 2;
    };
    const near = await view('tpw_near', 'left_out', { wall_gap: 0.15, wall_bounce: 0 });
    const far = await view('tpw_far', 'left_out', { wall_gap: 0.8, wall_bounce: 0 });
    expect(near.success && far.success).toBe(true);

    const a = halfHeight(near.trace('out'), rowOfFloor(2));
    const b = halfHeight(far.trace('out'), rowOfFloor(2));
    expect(b).toBeGreaterThan(a * 2.5);
  });

  it('a throw floods the wall', async () => {
    // The impact. Mid-flight the rings have opened out, so what lands is a wide
    // soft flare over the bars rather than three more bars — which is what it
    // looked like before the ghosts' own opening was carried out here.
    const area = (f: any, t: number) => {
      let n = 0;
      for (let y = 0; y < H; y += 2)
        for (let x = 0; x < W; x += 2) if (level(f.pixelAt(x, y)) > t) n++;
      return n;
    };
    // On a MUTED tower, which is what a throw actually is: the rig spends the
    // latched charge as the floors go dark, and a lit floor holds its own ring
    // down besides. Comparing against a blazing tower measures the tower.
    const muted = { plane1_emission: 0.15, plane2_emission: 0.15, plane3_emission: 0.15 };
    const rest = await view('tpw_rest', 'left_out', { ...muted, release: 0 });
    const thrown = await view('tpw_throw', 'left_out',
                              { ...muted, release: 0.65, release_gain: 2.2 });
    expect(rest.success && thrown.success).toBe(true);

    // A muted tower puts almost nothing on the wall; the throw floods it. Stated
    // as two absolutes rather than a ratio, because the resting figure is
    // nearly zero and a ratio against nearly zero says nothing.
    expect(area(rest.trace('out'), 40)).toBeLessThan(300);
    expect(area(thrown.trace('out'), 40)).toBeGreaterThan(2000);
    // And the flare is SOFT: it reaches well above the top floor's own bar,
    // where a resting tower puts almost nothing.
    const y = rowOfFloor(2) - 34;
    expect(level(thrown.trace('out').pixelAt(W / 2, y)))
      .toBeGreaterThan(level(rest.trace('out').pixelAt(W / 2, y)) + 25);
  });

  it('the two walls agree with the ring square on', async () => {
    // Square on, the ring faces both walls identically and there is nothing
    // that could tell them apart. Turned off square there is — see below.
    const l = await view('tpw_sym_l', 'left_out', {});
    const r = await view('tpw_sym_r', 'right_out', {});
    expect(l.success && r.success).toBe(true);
    for (const [x, y] of [[W / 2, rowOfFloor(0)], [W / 2, rowOfFloor(2)],
                          [60, rowOfFloor(1)], [W - 60, rowOfFloor(1)]]) {
      const a = l.trace('out').pixelAt(x, y);
      const b = r.trace('out').pixelAt(x, y);
      expect(Math.abs(luma(a) - luma(b))).toBeLessThan(3);
    }
  });

  it('an off-square orbit leans the pool, and the two walls lean opposite ways',
     async () => {
    // The orbit's own effect, and the only thing that makes the two outputs
    // different pictures. Turned off square, one corner of the ring is nearest
    // the wall and the pool leans to it — and because a square is symmetric
    // through its centre, the corner nearest THIS wall and the one nearest the
    // far wall sit on opposite sides of the room. So the two lean apart, by the
    // same amount, which is a mirror rather than a coincidence.
    const centroid = (f: any) => {
      let sum = 0, w = 0;
      for (let y = 0; y < H; y += 2)
        for (let x = 0; x < W; x += 2) {
          const v = level(f.pixelAt(x, y));
          if (v > 60) { sum += v * x; w += v; }
        }
      return w > 0 ? sum / w : W / 2;
    };
    const p = { orbit_azimuth: 0.06 };
    const l = await view('tpw_orb_l', 'left_out', p);
    const r = await view('tpw_orb_r', 'right_out', p);
    expect(l.success && r.success).toBe(true);

    const cl = centroid(l.trace('out'));
    const cr = centroid(r.trace('out'));
    // Well off centre...
    expect(cl - W / 2).toBeGreaterThan(20);
    expect(W / 2 - cr).toBeGreaterThan(20);
    // ...and mirrored about it.
    expect(Math.abs((cl - W / 2) - (W / 2 - cr))).toBeLessThan(6);
  });

  it('a corner pointing straight at the wall is symmetric again', async () => {
    // At 45 the ring's corner faces the wall square on, so there is nothing to
    // lean toward and the two walls agree again. Between the two the lean grows
    // and falls — this is what says the asymmetry is the GEOMETRY and not a
    // constant offset someone added to one side.
    const l = await view('tpw_45_l', 'left_out', { orbit_azimuth: 0.125 });
    const r = await view('tpw_45_r', 'right_out', { orbit_azimuth: 0.125 });
    expect(l.success && r.success).toBe(true);
    for (const [x, y] of [[W / 2, rowOfFloor(2)], [W / 2 - 60, rowOfFloor(1)],
                          [W / 2 + 60, rowOfFloor(1)]]) {
      expect(Math.abs(level(l.trace('out').pixelAt(x, y))
                    - level(r.trace('out').pixelAt(x, y)))).toBeLessThan(4);
    }
  });

  it('elevation squashes the light the way it squashes the picture',
     async () => {
    // A floor's pool lands at the height that floor is DRAWN at, so tilting the
    // camera down compresses the wall light in exactly the same proportion.
    // That is what keeps a triptych of left / main / right reading as one room.
    const span = (f: any) => {
      let lo = H, hi = -1;
      for (let y = 0; y < H; y++)
        if (level(f.pixelAt(W / 2, y)) > 60) { if (y < lo) lo = y; hi = y; }
      return hi < lo ? 0 : hi - lo;
    };
    const flat = await view('tpw_elev_a', 'left_out', { wall_bounce: 0 });
    const steep = await view('tpw_elev_b', 'left_out',
                             { wall_bounce: 0, elevation: 75 });
    expect(flat.success && steep.success).toBe(true);

    const want = Math.cos((75 * Math.PI) / 180) / ELEV_COS;
    const got = span(steep.trace('out')) / span(flat.trace('out'));
    expect(got).toBeGreaterThan(want * 0.8);
    expect(got).toBeLessThan(want * 1.2);
    // ...and the floors are still in the picture's own places: the bottom one
    // is still red and still at the bottom, at the row the squash puts it.
    const bottom = steep.trace('out')
      .pixelAt(W / 2, rowOfFloor(0, Math.cos((75 * Math.PI) / 180)));
    expect(bottom.r).toBeGreaterThan(bottom.g + 40);
    expect(bottom.r).toBeGreaterThan(bottom.b + 40);
  });

  it('draws nothing at all when nobody is wired to it', async () => {
    const wired = await view('tpw_wired', 'left_out', {});
    const unwired = await view('tpw_unwired', 'left_out', {}, false);
    expect(wired.success && unwired.success).toBe(true);
    // Wired, the sketch output IS the wall. Unwired, the send publishes its
    // chain input instead — the tower's own picture, which at the top floor's
    // height is nothing like a flat bar across the frame.
    const y = rowOfFloor(2);
    expect(level(wired.trace('out').pixelAt(W / 2, y))).toBeGreaterThan(150);
    // Unwired, the send publishes its chain input instead — the tower's own
    // picture, which is a different image throughout rather than a dimmer one.
    let differing = 0, n = 0;
    for (let yy = 0; yy < H; yy += 4)
      for (let xx = 0; xx < W; xx += 4, n++)
        if (Math.abs(luma(wired.trace('out').pixelAt(xx, yy))
                   - luma(unwired.trace('out').pixelAt(xx, yy))) > 24) differing++;
    expect(differing).toBeGreaterThan(n * 0.05);
  });
});
