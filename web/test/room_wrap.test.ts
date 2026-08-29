import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

// util.room_wrap — one picture cut into the three panels a room wants.
//
// Driven through a real sketch rather than the per-effect GPU harness, because
// two of its three outputs are SECONDARY texture outputs and only a wire can
// reach those. The reader is chroma_wave's: wire the side output into a
// sidechannel send's `send_in` and put the matching receive after it, and the
// SKETCH OUTPUT is that side pane.
//
// THE PROBE IS A RAMP, AND THE RAMP IS READ BACK RATHER THAN ASSUMED. Every
// case here asks "which column of the input is this pixel showing", which on a
// left-to-right ramp is a question about grey — but only if you know the
// transfer curve between the two, and nothing here should depend on knowing it.
// So the same gradient is captured on its own first, and `uOf` inverts that
// measurement. The assertions are then in units of the SOURCE, which is what
// the geometry is actually about.
describe('Room Wrap E2E', () => {
  jest.setTimeout(180000);

  const W = 200, H = 100;
  const MODULES = ['com.nano.core'];
  const MID_Y = Math.round(H / 2);

  // A left-to-right black-to-white ramp filling the frame. Softness 1 spreads
  // the blend over the whole sweep, so `t` is the position and nothing else.
  const RAMP = { angle: 0, offset: 0, softness: 1,
                 color_a: [0, 0, 0], color_b: [1, 1, 1] };
  // The same ramp turned a quarter, for the cases about the vertical. The frame
  // is twice as wide as it is tall and the sweep is measured on the LONG axis,
  // so half the ramp would fall outside the frame — softness 0.5 is what pulls
  // the two ends back onto the top and bottom rows.
  const VRAMP = { ...RAMP, angle: 0.5, softness: 0.5 };

  /** gradient -> room_wrap, with a side output relayed out if asked for. */
  // `relay` puts the receive in and the sketch output IS the side pane;
  // without it the send just passes the middle down the chain, which is how a
  // case can have the side pass switched ON and still be looking at the middle.
  const sketch = (params: Record<string, unknown>,
                  src: Record<string, unknown>,
                  side: 'left_out' | 'right_out' | null,
                  relay: boolean): Sketch => ({
    anchor: null,
    wires: side ? [{ id: 'ws', src: { instanceKey: 'rw@0', field: side },
                     dest: { instanceKey: 'send@0', field: 'send_in' } }] : [],
    chain: [
      { type: 'module', module_type: 'source.gradient', instance_key: 'g@0', params: src },
      { type: 'module', module_type: 'util.room_wrap', instance_key: 'rw@0', params },
      ...(side ? [
        { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send@0',
          params: { channel: 5 } },
        ...(relay ? [{ type: 'module', module_type: 'util.sidechannel_in',
                       instance_key: 'recv@0', params: { channel: 5 } }] : []),
      ] : []),
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, unknown>,
               side: 'left_out' | 'right_out' | null = null,
               src: Record<string, unknown> = RAMP,
               relay = true) =>
    runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: sketch(params, src, side, relay) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });

  /** The ramp on its own, so every grey below can be read back as a position. */
  const reference = async (id: string, src: Record<string, unknown>) => {
    const r = await runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: {
            anchor: null, wires: [],
            chain: [{ type: 'module', module_type: 'source.gradient',
                      instance_key: 'g@0', params: src }],
          } as Sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });
    expect(r.success).toBe(true);
    return r.trace('out');
  };

  /** Grey -> where in the source it came from, by inverting the measured ramp. */
  const inverter = (greys: number[]) => (grey: number) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < greys.length; i++) {
      const d = Math.abs(greys[i] - grey);
      if (d < bestD) { bestD = d; best = i; }
    }
    return (best + 0.5) / greys.length;
  };

  let uOf: (grey: number) => number;      // horizontal ramp
  let vOf: (grey: number) => number;      // vertical ramp
  beforeAll(async () => {
    const h = await reference('rw_ref_h', RAMP);
    const v = await reference('rw_ref_v', VRAMP);
    uOf = inverter(Array.from({ length: W }, (_, x) => h.pixelAt(x, MID_Y).r));
    vOf = inverter(Array.from({ length: H }, (_, y) => v.pixelAt(Math.round(W / 2), y).r));
  });

  // A column is a whole pixel wide and the ramp only has 200 of them, so a
  // position read back through `uOf` is good to about half a percent. Every
  // tolerance below is that, loosened for the far ends of a wall where the
  // source is minified and one output pixel covers several input ones.
  const SLOP = 0.02;

  it('the middle output is a centred zoom of the input', async () => {
    // Scale 3 puts the back wall over the middle third of the picture: its own
    // edges read the input's thirds, and its centre reads the input's centre.
    const r = await run('rw_mid', { scale: 3, perspective: 1 });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    expect(uOf(f.pixelAt(1, MID_Y).r)).toBeCloseTo(1 / 3, 1);
    expect(uOf(f.pixelAt(W / 2, MID_Y).r)).toBeCloseTo(0.5, 1);
    expect(uOf(f.pixelAt(W - 2, MID_Y).r)).toBeCloseTo(2 / 3, 1);
  });

  it('the seams join continuously', async () => {
    // THE headline. A side pane's inner edge must read the same column of the
    // picture the middle's edge does — at every setting, because the wall map
    // is the identity at the seam by construction rather than by tuning. A
    // wipe that jumps at a corner is the one thing this card must not do.
    for (const perspective of [0, 0.5, 1]) {
      const mid = await run(`rw_seam_m${perspective}`, { scale: 3, perspective });
      const left = await run(`rw_seam_l${perspective}`, { scale: 3, perspective }, 'left_out');
      const right = await run(`rw_seam_r${perspective}`, { scale: 3, perspective }, 'right_out');
      expect(mid.success && left.success && right.success).toBe(true);
      // The left pane runs the other way: its RIGHT edge is the one that meets
      // the middle, which is the layout triptych reads back.
      expect(uOf(left.trace('out').pixelAt(W - 2, MID_Y).r))
        .toBeCloseTo(uOf(mid.trace('out').pixelAt(1, MID_Y).r), 1);
      expect(uOf(right.trace('out').pixelAt(1, MID_Y).r))
        .toBeCloseTo(uOf(mid.trace('out').pixelAt(W - 2, MID_Y).r), 1);
    }
  });

  it('the three panes tile the picture, losing none of it', async () => {
    // The far end of each wall lands on the far edge of the source, so the
    // union of the three panes is the whole picture with nothing repeated.
    const left = await run('rw_tile_l', { scale: 3, perspective: 1 }, 'left_out');
    const right = await run('rw_tile_r', { scale: 3, perspective: 1 }, 'right_out');
    expect(left.success && right.success).toBe(true);
    expect(uOf(left.trace('out').pixelAt(1, MID_Y).r)).toBeLessThan(0.03);
    expect(uOf(right.trace('out').pixelAt(W - 2, MID_Y).r)).toBeGreaterThan(0.97);
  });

  it('Perspective foreshortens the wall toward its far end', async () => {
    // Halfway along the left wall, in the wall's OWN coordinate. At
    // Perspective 0 that is halfway along its share of the picture — a plain
    // linear stretch, so 1/6 of the way in from the left edge. At 1 the far
    // half of the wall is compressed into the outer half of the panel, so the
    // same pixel is looking much closer to the seam: exactly a quarter, which
    // is what the depth ratio of 3 puts there.
    const flat = await run('rw_persp0', { scale: 3, perspective: 0 }, 'left_out');
    const deep = await run('rw_persp1', { scale: 3, perspective: 1 }, 'left_out');
    expect(flat.success && deep.success).toBe(true);
    const uFlat = uOf(flat.trace('out').pixelAt(W / 2, MID_Y).r);
    const uDeep = uOf(deep.trace('out').pixelAt(W / 2, MID_Y).r);
    expect(uFlat).toBeCloseTo(1 / 6, 2);
    expect(uDeep).toBeCloseTo(1 / 4, 2);
    // And the direction is the whole point: the room pulls the picture back
    // toward the corner, it does not push it away.
    expect(uDeep).toBeGreaterThan(uFlat + SLOP);
  });

  it('the keystone opens the wall vertically by the same ratio', async () => {
    // Screen x and screen y both go as 1/z, so ONE number carries both. At
    // Scale 3 the middle crops to the input's middle third; the wall's seam
    // must match that exactly, and its far end must have opened out by three —
    // which is the whole picture, top to bottom.
    const left = await run('rw_vert', { scale: 3, perspective: 1 }, 'left_out', VRAMP);
    expect(left.success).toBe(true);
    const f = left.trace('out');
    const seamTop = vOf(f.pixelAt(W - 2, 1).r);
    const seamBot = vOf(f.pixelAt(W - 2, H - 2).r);
    const farTop  = vOf(f.pixelAt(1, 1).r);
    const farBot  = vOf(f.pixelAt(1, H - 2).r);
    // The seam column: the middle third of the input, same as the mid pane.
    expect(Math.abs(seamTop - 1 / 3)).toBeLessThan(0.06);
    expect(Math.abs(seamBot - 2 / 3)).toBeLessThan(0.06);
    // The far column: all of it.
    expect(farTop).toBeLessThan(0.08);
    expect(farBot).toBeGreaterThan(0.92);
    // Stated as the ratio, which is the thing that has to match the horizontal.
    expect((farBot - farTop) / (seamBot - seamTop)).toBeCloseTo(3, 0);
  });

  it('Scale 1 fills the middle and leaves the walls nothing to show', async () => {
    // With no overflow the walls are a degenerate strip of the picture's own
    // edge — flat, and the same colour as the edge they hang off. It must not
    // be a repeat of the middle, which is what a missing zoom term would give.
    const mid = await run('rw_s1_m', { scale: 1, perspective: 1 });
    const left = await run('rw_s1_l', { scale: 1, perspective: 1 }, 'left_out');
    expect(mid.success && left.success).toBe(true);
    // The middle is the whole picture again, edge to edge.
    expect(uOf(mid.trace('out').pixelAt(1, MID_Y).r)).toBeLessThan(0.03);
    expect(uOf(mid.trace('out').pixelAt(W - 2, MID_Y).r)).toBeGreaterThan(0.97);
    // The wall is the left edge, all the way across.
    const f = left.trace('out');
    for (const x of [1, W / 4, W / 2, W - 2])
      expect(uOf(f.pixelAt(x, MID_Y).r)).toBeLessThan(0.03);
  });

  it('a round trip through Triptych gives the picture back', async () => {
    // The two cards are inverses, and this is that claim made of real pixels:
    // cut the ramp into three panels here, composite them back into a room
    // there with the matching knobs, and read the result along the middle row.
    // Every step of the geometry has to be right for this to hold — the zoom,
    // both wall maps, and the fact that they are the same map read in opposite
    // directions (shaders_common/nano_room_wall.hlsl).
    //
    // Triptych sizes its back wall in THIRDS of the frame, so a Scale of 3 is
    // its Middle Size of 1. Only the middle row is compared: the room has no
    // ceiling and no floor, so above and below the walls' trapezoids there is
    // nothing to put anywhere and triptych leaves it transparent — correctly.
    const id = 'rw_roundtrip';
    const r = await runEngineTest({
      width: W, height: H, modules: MODULES,
      commands: [
        { type: 'createSketch', sketchId: id, sketch: {
            anchor: null,
            wires: [
              { id: 'wl', src: { instanceKey: 'rw@0', field: 'left_out' },
                dest: { instanceKey: 'tp@0', field: 'left_in' } },
              { id: 'wr', src: { instanceKey: 'rw@0', field: 'right_out' },
                dest: { instanceKey: 'tp@0', field: 'right_in' } },
            ],
            chain: [
              { type: 'module', module_type: 'source.gradient', instance_key: 'g@0',
                params: RAMP },
              { type: 'module', module_type: 'util.room_wrap', instance_key: 'rw@0',
                params: { scale: 3, perspective: 1 } },
              { type: 'module', module_type: 'util.triptych', instance_key: 'tp@0',
                params: { fit_mode: 3, gap: 0, mid_scale: 1, perspective: 1 } },
            ],
          } as Sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 20, captureTraceIds: ['out'], dumpName: id,
    });
    expect(r.success).toBe(true);
    const f = r.trace('out');
    // Skip the two seams themselves: they are one pixel wide, and which side
    // of a boundary a sample lands on is a question about rounding rather than
    // about the geometry.
    for (let x = 4; x < W - 4; x += 4) {
      if (Math.abs(x - W / 3) < 3 || Math.abs(x - (2 * W) / 3) < 3) continue;
      expect(uOf(f.pixelAt(x, MID_Y).r)).toBeCloseTo((x + 0.5) / W, 1);
    }
  });

  it('switching a side pass on does not disturb the middle', async () => {
    // The side passes are gated on a wire, so the common "just a zoom" case is
    // one dispatch. Both runs here look at the MIDDLE — the wired one relays
    // nothing, so its side pane is being drawn into an effect-owned texture
    // off to one side while the chain carries on. The two must be the same
    // picture: an extra pass that wrote over the middle, or a uniform buffer
    // shared between the panes, would show up here as the middle wearing the
    // left wall's geometry.
    const off = await run('rw_gate_off', { scale: 2, perspective: 1 });
    const on  = await run('rw_gate_on', { scale: 2, perspective: 1 }, 'left_out',
                          RAMP, false);
    expect(off.success && on.success).toBe(true);
    for (let x = 2; x < W - 2; x += 8) {
      expect(Math.abs(off.trace('out').pixelAt(x, MID_Y).r
                    - on.trace('out').pixelAt(x, MID_Y).r)).toBeLessThanOrEqual(2);
    }
    // ...and it really is the zoomed middle in both, not a pass-through.
    expect(uOf(off.trace('out').pixelAt(1, MID_Y).r)).toBeCloseTo(0.25, 1);
  });
});
