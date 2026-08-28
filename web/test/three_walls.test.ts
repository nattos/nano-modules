import { runGpuEffectTest, Frame, forEachBackend } from './gpu-test-helpers';
import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

// Per-effect tests for source.mesh.three_walls — three neon frames rushing down
// a tunnel, rendered from three cameras into three texture outputs.
//
// What is tested WHERE, and why:
//
//   * The moves themselves (the pulse train, the rate ramps, the gates, and
//     above all the frame-locked advance) are pinned host-free by
//     native/tests/test_three_walls_show.cpp, which drives them at an exact dt.
//     Nothing here re-tests that arithmetic.
//   * The main output runs on BOTH backends with plain `ticks`. That works
//     because every bit of this effect's state is CPU-side — there is no
//     persistent GPU state — so N ticks then one render is identical to N
//     tick/render pairs, and `renderEachTick` (which the Metal single-module
//     path silently drops) is not needed.
//   * The two side views can only be read through a real sketch, so they use
//     the engine harness and the sidechannel trick from chroma_wave.test.ts.
//     Engine dt is wall clock, so those cases assert GEOMETRY, never timing.

forEachBackend((backend) => {
describe(`Three Walls E2E (${backend})`, () => {
  jest.setTimeout(90000);

  const W = 240, H = 160;
  const MODULE = 'source.mesh.three_walls';
  const BUNDLE = 'lights' as const;

  // A quiet grade, so the assertions are about the projection rather than the
  // analogue tail.
  const QUIET: [string, number][] = [['grain', 0], ['scanline', 0], ['chroma_bleed', 0]];

  const luma = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3;

  /** How many pixels carry real light. The blunt "is anything there" measure. */
  const litCount = (f: Frame, threshold = 40) => {
    let n = 0;
    f.forEachPixel((p) => { if (luma(p) > threshold) n++; });
    return n;
  };

  /** Half-width of the lit region, in pixels — how big the frame has grown. */
  const litHalfWidth = (f: Frame, threshold = 60) => {
    let lo = W, hi = -1;
    f.forEachPixel((p, x) => {
      if (luma(p) > threshold) { if (x < lo) lo = x; if (x > hi) hi = x; }
    });
    return hi < lo ? 0 : (hi - lo) / 2;
  };

  /** Is there a clearly cyan pixel? Frame 3's colour, and nothing else's. */
  const hasCyan = (f: Frame) => {
    let found = false;
    f.forEachPixel((p) => { if (p.b > 120 && p.g > 100 && p.r + 60 < p.b) found = true; });
    return found;
  };
  /** Is there a clearly magenta pixel? Frame 1's colour. */
  const hasMagenta = (f: Frame) => {
    let found = false;
    f.forEachPixel((p) => { if (p.r > 140 && p.g + 60 < p.r && p.b + 20 < p.r) found = true; });
    return found;
  };

  const run = (name: string, params: any[], ticks = 0) => runGpuEffectTest({
    module: MODULE, bundle: BUNDLE, width: W, height: H,
    inputColor: [0, 0, 0, 1],
    params: [...QUIET, ...params] as any,
    ticks,
    dumpName: name,
  });

  it('declares metadata', async () => {
    const f = await run('three_walls_metadata', []);
    expect(f.success).toBe(true);
    expect(f.metadata?.id).toBe(MODULE);
  });

  // The rest pose is NOTHING — the frames do not exist until a move puts them
  // there. That is the contract the whole card is built on, so it is the first
  // thing worth pinning.
  it('is black until a move fires', async () => {
    const idle = await run('three_walls_idle', [], 20);
    expect(idle.success).toBe(true);
    expect(litCount(idle)).toBeLessThan(20);

    const fired = await run('three_walls_fired', [['pulse', 1]], 20);
    expect(litCount(fired)).toBeGreaterThan(500);
  });

  it('a frame grows as it arrives', async () => {
    // One frame, launched alone, sampled twice on its way in. The tunnel maps
    // depth geometrically, so this is the check that the perspective divide is
    // actually happening rather than a fixed-size quad being drawn.
    const p = [['pulse', 1], ['pulse_time', 2.0], ['pulse_stagger', 5.0]];
    const early = await run('three_walls_grow_early', p, 8);
    const late  = await run('three_walls_grow_late', p, 40);
    expect(early.success && late.success).toBe(true);
    expect(litHalfWidth(early)).toBeGreaterThan(2);
    expect(litHalfWidth(late)).toBeGreaterThan(litHalfWidth(early) * 1.5);
  });

  it('Pulse is a train — the frames arrive one after another', async () => {
    // Frame 1 is magenta and frame 3 is cyan, so "how many have launched" is
    // readable straight off the colours.
    const p = [['pulse', 1], ['pulse_time', 1.2], ['pulse_stagger', 0.35]];
    const first = await run('three_walls_train_first', p, 6);    // ~0.1 s
    const all   = await run('three_walls_train_all', p, 50);     // ~0.8 s
    expect(first.success && all.success).toBe(true);
    expect(hasMagenta(first)).toBe(true);
    expect(hasCyan(first)).toBe(false);     // frame 3 has not launched yet
    expect(hasCyan(all)).toBe(true);        // by now it has
  });

  it('Pulse plays out and leaves the card black again', async () => {
    // 2*stagger + travel = 0.5 s, so 60 ticks at 16 ms is well past the end.
    const done = await run('three_walls_train_done',
                           [['pulse', 1], ['pulse_time', 0.3], ['pulse_stagger', 0.1]], 60);
    expect(done.success).toBe(true);
    expect(litCount(done)).toBeLessThan(20);
  });

  // A gate stays up. This is also the check that a held event value does not
  // re-arm the move every frame off the executor's replay — a re-arming
  // Resonate would keep resetting to its start pose instead of running.
  it('Resonate holds all three frames while the trigger is high', async () => {
    // Smaller frames than the default, so all three of the start pose fit in
    // the viewport at once — the nearest sits close enough to the lens that at
    // full size its outline is off-screen and only its glow is left.
    const f = await run('three_walls_resonate',
                        [['resonate', 1], ['resonate_f0', 0.2], ['resonate_f1', 0.2],
                         ['quad_size', 0.25]], 30);
    expect(f.success).toBe(true);
    expect(hasMagenta(f)).toBe(true);
    expect(hasCyan(f)).toBe(true);
    expect(litCount(f)).toBeGreaterThan(1000);
  });

  it('the frames keep moving under a held gate', async () => {
    const p: any[] = [['resonate', 1], ['resonate_f0', 0.5], ['resonate_f1', 0.5]];
    const a = await run('three_walls_moving_a', p, 10);
    const b = await run('three_walls_moving_b', p, 40);
    expect(a.success && b.success).toBe(true);
    a.expectDifferentFrom(b, 60);
  });
});
});

// --- The side views ---------------------------------------------------------
//
// Only reachable through a real sketch: wire the aux output into a
// util.sidechannel_out override and put a util.sidechannel_in after it, and the
// sketch output IS that texture (the trick from chroma_wave.test.ts:393).
// Engine dt is wall clock, so everything here is geometry.
describe('Three Walls side views', () => {
  jest.setTimeout(120000);
  const W = 240, H = 160;

  const luma = (p: { r: number; g: number; b: number }) => (p.r + p.g + p.b) / 3;
  const litCount = (f: any, threshold = 40) => {
    let n = 0;
    f.forEachPixel((p: any) => { if (luma(p) > threshold) n++; });
    return n;
  };
  /** The widest unbroken run of lit pixels on any row — a frame's on-screen
   *  width, which is what an edge-on camera destroys. */
  const widestRun = (f: any, threshold = 60) => {
    const rows: number[][] = Array.from({ length: H }, () => []);
    f.forEachPixel((p: any, x: number, y: number) => {
      if (luma(p) > threshold) rows[y].push(x);
    });
    let best = 0;
    for (const xs of rows) {
      if (xs.length === 0) continue;
      xs.sort((a, b) => a - b);
      let run = 1;
      for (let i = 1; i < xs.length; i++) {
        run = xs[i] === xs[i - 1] + 1 ? run + 1 : 1;
        if (run > best) best = run;
      }
      if (run > best) best = run;
    }
    return best;
  };

  /** Centre of mass of the lit pixels, in x. Left and right views mirror it. */
  const litCentroidX = (f: any, threshold = 60) => {
    let sum = 0, n = 0;
    f.forEachPixel((p: any, x: number) => {
      if (luma(p) > threshold) { sum += x; n++; }
    });
    return n > 0 ? sum / n : W / 2;
  };

  // A leading solid_color matters: three_walls reads tex_in, and an effect at
  // the head of a chain has no input texture to read.
  const build = (field: string, params: Record<string, unknown>): Sketch => ({
    anchor: null,
    wires: [{ id: 'ww', src: { instanceKey: 'tw@0', field },
              dest: { instanceKey: 'send@0', field: 'send_in' } }],
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
        params: { color: [0, 0, 0] } },
      { type: 'module', module_type: 'source.mesh.three_walls', instance_key: 'tw@0',
        params: { grain: 0, scanline: 0, chroma_bleed: 0, ...params } },
      { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send@0',
        params: { channel: 3 } },
      { type: 'module', module_type: 'util.sidechannel_in', instance_key: 'recv@0',
        params: { channel: 3 } },
    ],
  } as Sketch);

  const view = (id: string, field: string, params: Record<string, unknown>) =>
    runEngineTest({
      width: W, height: H,
      modules: ['com.nano.lights', 'com.nano.core'],
      commands: [
        { type: 'createSketch', sketchId: id, sketch: build(field, params) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: id } }]},
      ],
      waitFrames: 25, captureTraceIds: ['out'], dumpName: id,
    });

  // Held at a crawl so the frames are somewhere down the tunnel whatever the
  // wall clock did — no timing rides on this.
  const HELD = { resonate: 1, resonate_f0: 0.15, resonate_f1: 0.15 };

  it('the side views show the same tunnel from outside', async () => {
    const main = await view('tw_side_main', 'tex_out', HELD);
    const left = await view('tw_side_left', 'left_out', HELD);
    expect(main.success && left.success).toBe(true);

    // Both have content — so the aux allocation, the publish and the
    // connection gate all work — and they are different pictures, which is the
    // point: one looks down the tunnel, the other across it.
    expect(litCount(main.trace('out'))).toBeGreaterThan(500);
    expect(litCount(left.trace('out'))).toBeGreaterThan(500);
    main.trace('out').expectDifferentFrom(left.trace('out'), 60);
  });

  it('left and right are mirror images of each other', async () => {
    const left = await view('tw_side_l', 'left_out', HELD);
    const right = await view('tw_side_r', 'right_out', HELD);
    expect(left.success && right.success).toBe(true);

    // The nearest frame is the biggest, so it dominates the centre of mass and
    // sits on opposite sides of the two views.
    const lx = litCentroidX(left.trace('out'));
    const rx = litCentroidX(right.trace('out'));
    expect(Math.abs(lx - rx)).toBeGreaterThan(W * 0.15);
    expect(Math.abs((lx + rx) / 2 - W / 2)).toBeLessThan(W * 0.12);
  });

  // The knob the whole side-view idea rests on. At 90 degrees the cameras are
  // exactly edge-on to the frames, which are flat — so each one collapses to a
  // sliver and a pulse would cross it in no time. It does not go entirely dark,
  // because the tube has a width of its own and that survives being seen
  // edge-on; what collapses is the AREA, which is what "infinitely thin" means
  // here in practice.
  it('a 90 degree side angle takes the frames edge-on', async () => {
    const open = await view('tw_side_open', 'left_out', { ...HELD, side_angle: 55 });
    const flat = await view('tw_side_flat', 'left_out', { ...HELD, side_angle: 90 });
    expect(open.success && flat.success).toBe(true);
    expect(litCount(open.trace('out'))).toBeGreaterThan(500);
    expect(litCount(flat.trace('out'))).toBeLessThan(
      litCount(open.trace('out')) * 0.5);
    // And the collapse is in WIDTH: the widest lit run across a row is a
    // trapezoid at 55 degrees and a sliver at 90.
    expect(widestRun(flat.trace('out'))).toBeLessThan(
      widestRun(open.trace('out')) * 0.4);
  });

  it('the main view is unaffected by whether the side views are wired',
     async () => {
    // The aux dispatches are gated on connectivity, and that gate must not be
    // able to change what the main output looks like.
    const alone = await view('tw_gate_alone', 'tex_out', HELD);
    const withAux = await runEngineTest({
      width: W, height: H,
      modules: ['com.nano.lights', 'com.nano.core'],
      commands: [
        { type: 'createSketch', sketchId: 'tw_gate_both', sketch: {
          anchor: null,
          wires: [
            { id: 'w1', src: { instanceKey: 'tw@0', field: 'tex_out' },
              dest: { instanceKey: 'send@0', field: 'send_in' } },
            // A second consumer of an aux view, so its dispatch runs too.
            { id: 'w2', src: { instanceKey: 'tw@0', field: 'left_out' },
              dest: { instanceKey: 'send2@0', field: 'send_in' } },
          ],
          chain: [
            { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
              params: { color: [0, 0, 0] } },
            { type: 'module', module_type: 'source.mesh.three_walls', instance_key: 'tw@0',
              params: { grain: 0, scanline: 0, chroma_bleed: 0, ...HELD } },
            { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send2@0',
              params: { channel: 4 } },
            { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send@0',
              params: { channel: 3 } },
            { type: 'module', module_type: 'util.sidechannel_in', instance_key: 'recv@0',
              params: { channel: 3 } },
          ],
        } as Sketch },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'tw_gate_both' } }]},
      ],
      waitFrames: 25, captureTraceIds: ['out'], dumpName: 'tw_gate_both',
    });
    expect(alone.success && withAux.success).toBe(true);
    // Same move at the same crawl, so the two main views agree up to the frames
    // the wall clock happened to land on.
    expect(litCount(withAux.trace('out'))).toBeGreaterThan(500);
  });
});
