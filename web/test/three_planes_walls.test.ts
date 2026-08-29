import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * `left_out` / `right_out` — the impact light `source.mesh.three_planes` throws
 * onto the walls of the room it stands in.
 *
 * A LIGHT MODEL, not a second picture of the tower: nothing in the pass draws a
 * quad. Each floor is a ring of light a fixed gap off the wall, so what lands
 * is a bar — flat across the ring, falling away past its ends — under a wide
 * dim bounce. Everything below is checking that the SHAPE is the one the
 * geometry gives rather than an authored gradient, because that is the whole
 * difference between light on a wall and bad lighting in an old game.
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

  // The wall shows one stack-unit either side of centre, and the floors sit at
  // -spacing / 0 / +spacing. At the default 0.42 that puts them here.
  const SPACING = 0.42;
  const rowOfFloor = (i: number) => Math.round((0.5 - ((i - 1) * SPACING) / 2) * H);

  const luma = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3;

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

  it('the bar is flat across the ring and falls away past its ends',
     async () => {
    // The emitter has width, so its pool does too. This is what makes it read
    // as a bar thrown by an object rather than a blob centred on a point — and
    // it is the first thing an authored gradient gets wrong.
    const r = await view('tpw_bar', 'left_out', {});
    expect(r.success).toBe(true);
    const f = r.trace('out');
    const y = rowOfFloor(2);

    // The ring is 0.62 of a stack unit either side of centre and the wall shows
    // 1 unit scaled by the aspect, so the flat top runs about a third of the
    // half-width out. Sample well inside it.
    const mid = luma(f.pixelAt(W / 2, y));
    for (const x of [W / 2 - 60, W / 2 + 60]) {
      expect(Math.abs(luma(f.pixelAt(x, y)) - mid)).toBeLessThan(mid * 0.08);
    }
    // ...and then it goes. Out at the edge of the wall there is bounce and
    // little else.
    expect(luma(f.pixelAt(12, y))).toBeLessThan(mid * 0.3);
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
    const near = await view('tpw_near', 'left_out', { wall_gap: 0.2, wall_bounce: 0 });
    const far = await view('tpw_far', 'left_out', { wall_gap: 0.7, wall_bounce: 0 });
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
        for (let x = 0; x < W; x += 2) if (luma(f.pixelAt(x, y)) > t) n++;
      return n;
    };
    const rest = await view('tpw_rest', 'left_out', { release: 0 });
    const thrown = await view('tpw_throw', 'left_out',
                              { release: 0.65, release_gain: 2.2 });
    expect(rest.success && thrown.success).toBe(true);

    // Brighter, and over much more of the wall.
    expect(area(thrown.trace('out'), 100)).toBeGreaterThan(
      area(rest.trace('out'), 100) * 1.6);
    // And the flare is SOFT: it reaches well above the top floor's own bar,
    // where a resting tower puts almost nothing.
    const y = rowOfFloor(2) - 34;
    expect(luma(thrown.trace('out').pixelAt(W / 2, y)))
      .toBeGreaterThan(luma(rest.trace('out').pixelAt(W / 2, y)) + 25);
  });

  it('the two walls agree when nothing is sweeping the room', async () => {
    // The room is symmetric about the stack and the orbit is deliberately
    // ignored — a square turned about its own axis presents the same
    // silhouette to both walls, so there is genuinely nothing to tell them
    // apart. The glints are the one thing that does, and they are off here.
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

  it('draws nothing at all when nobody is wired to it', async () => {
    const wired = await view('tpw_wired', 'left_out', {});
    const unwired = await view('tpw_unwired', 'left_out', {}, false);
    expect(wired.success && unwired.success).toBe(true);
    // Wired, the sketch output IS the wall. Unwired, the send publishes its
    // chain input instead — the tower's own picture, which at the top floor's
    // height is nothing like a flat bar across the frame.
    const y = rowOfFloor(2);
    expect(luma(wired.trace('out').pixelAt(W / 2, y))).toBeGreaterThan(120);
    expect(Math.abs(luma(wired.trace('out').pixelAt(30, y))
                  - luma(unwired.trace('out').pixelAt(30, y)))).toBeGreaterThan(10);
  });
});
