import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.motion shaper node — a normalized differentiator
 * (how fast is the input moving) with catch-fast/coast-slow momentum and an
 * optional Activity/Throw integrator. `output` is unsigned speed (or the
 * integrator level); `velocity` is the signed post-momentum velocity.
 *
 * Rate semantics: displacement over the last `smooth` seconds (a boxcar
 * window). A one-frame step of Δ=1 reads ≥ Δ/window (clamped → pegged) for
 * EXACTLY the window duration, then drops to an exact 0 — no exponential
 * tail. Tests use window 0.3 s so peg captures a few frames after a step sit
 * inside the window at any frame rate, and "decayed" captures sit past it.
 *
 * Probe chain: white solid → motion → brightness_contrast, with the chosen
 * output wired into bc.brightness (combine:'replace'): with contrast -0.5 on
 * white input, display ≈ clamp01(raw)*255 for the unsigned output, and the
 * SIGNED velocity folds -1/0/+1 → 0/128/255 (tap_mod.h Replace fold).
 *
 * Timing: the harness runs real rAF dt, and headless rAF is NOT vsync-locked
 * — measured anywhere from ~4 to ~16 ms/frame. Every wait below is sized so
 * its assertion holds across dt ∈ [4 ms, 20 ms] (worst cases checked in
 * comments). Params are always set explicitly so retuning shipped defaults
 * can't break the suite.
 */
describe('mod.shaper.motion shaper node E2E', () => {
  jest.setTimeout(90000);

  const build = (params: Record<string, number | boolean>, field: string): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.shaper.motion', instance_key: 'mo@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'mo@0', field },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  // Multi-phase runner: create with `params`, then per step setParam a key on
  // the motion node (chainIdx 1) and capture after `frames`.
  const runPhases = (
    id: string,
    params: Record<string, number | boolean>,
    field: string,
    steps: Array<{ key?: string, value?: number, frames: number }>,
  ) => runEngineMultiPhaseTest({
    width: 64, height: 64,
    modules: ['com.nano.core'],
    phases: [
      { commands: [
          { type: 'createSketch', sketchId: id, sketch: build(params, field) },
          { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
        ],
        waitFrames: 20, captureTraceIds: ['out'] },
      ...steps.map(s => ({
        commands: s.key !== undefined
          ? [{ type: 'setParam' as const, sketchId: id, colIdx: 0, chainIdx: 1, paramKey: s.key, value: s.value }]
          : [],
        waitFrames: s.frames, captureTraceIds: ['out'],
      })),
    ],
    dumpName: id,
  });

  it('a resting input reads zero — including the creation replay (no ghost spike)', async () => {
    // input 0.7 arrives via the initial state replay; with momentum 1 a ghost
    // velocity spike would still be coasting near-pegged at frame 20. The
    // initialized seed must absorb it: output stays black.
    const r = await runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: 'mo_rest',
        sketch: build({ input: 0.7, momentum: 1, smooth: 0.3, curve: 1, sense: 1, integrate: false, sharpen: 0, scale: 1, rolloff: 0 }, 'output') }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'mo_rest' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'mo_rest',
    });
    expect(r.success).toBe(true);
    expect(r.trace('out').averageColor().r).toBeLessThan(10);
  });

  it('an input step spikes the speed, which then decays (momentum 0)', async () => {
    const r = await runPhases('mo_spike',
      { input: 0, momentum: 0, smooth: 0.3, curve: 1, sense: 1, integrate: false, sharpen: 0, scale: 1, rolloff: 0 }, 'output', [
        { key: 'input', value: 1, frames: 5 },   // ≤0.1 s: inside the 0.3 s window → pegged
        { frames: 120 },                         // 0.48-2.4 s: well past the window → exact 0
      ]);
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeLessThan(15);
    expect(r.phases[1].trace('out').averageColor().r).toBeGreaterThan(200);
    // The boxcar releases to an EXACT zero (no exponential tail) — the
    // tightness that motivated it.
    expect(r.phases[2].trace('out').averageColor().r).toBeLessThan(10);
  });

  it('momentum holds the speed reading long after the flick', async () => {
    // Identical flick, captured 90 frames (0.36-1.8 s across dt range) later:
    // momentum 0 is EXACTLY zero (the 0.3 s window has passed); momentum 1
    // (coast tau 2 s) still holds e^-0.03..e^-0.75 ≈ 0.47..0.97 of pegged.
    const flick = (id: string, momentum: number) => runPhases(id,
      { input: 0, momentum, smooth: 0.3, curve: 1, sense: 1, integrate: false, sharpen: 0, scale: 1, rolloff: 0 }, 'output', [
        { key: 'input', value: 1, frames: 90 },
      ]);
    const m0 = await flick('mo_m0', 0);
    const m1 = await flick('mo_m1', 1);
    expect(m0.success && m1.success).toBe(true);
    const r0 = m0.phases[1].trace('out').averageColor().r;
    const r1 = m1.phases[1].trace('out').averageColor().r;
    expect(r0).toBeLessThan(30);
    expect(r1).toBeGreaterThan(90);
    expect(r1).toBeGreaterThan(r0 + 60);
  });

  it('Activity mode charges while wiggling and drains at rest', async () => {
    const r = await runPhases('mo_act',
      { input: 0, momentum: 0, smooth: 0.3, curve: 1, sense: 1, integrate: true, mode: 0, decay: 0.6, sharpen: 0, scale: 1, rolloff: 0 },
      'output', [
        { key: 'input', value: 1, frames: 20 },
        { key: 'input', value: 0, frames: 20 },
        { key: 'input', value: 1, frames: 20 },
        { key: 'input', value: 0, frames: 20 },
        { frames: 450 },  // 1.8-9 s idle: ≥2.5 decay taus past the 0.3 s window
      ]);
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeLessThan(15);
    // Instant attack: the envelope snaps to the pegged |v| on any step.
    expect(r.phases[4].trace('out').averageColor().r).toBeGreaterThan(150);
    expect(r.phases[5].trace('out').averageColor().r).toBeLessThan(45);
  });

  it('Throw mode rests at 0, arcs up ballistically on a flick, and falls back home', async () => {
    // Ballistics with return_time 1 (g = 2): a flick thrusts at g*(4|v|-1) =
    // 6/s² through the 0.3 s window → u ≈ 1.8, ceiling-clamped apex ≈ 1 held
    // ~0.7-1.5 s after the step, then a ~1 s fall to an exact 0. The parabola
    // peaks at a dt-dependent FRAME index, so capture three points spanning
    // 0.16-5 s and assert the trajectory's max — at least one capture lands
    // in the high arc at any dt in [4, 20] ms.
    const r = await runPhases('mo_throw',
      { input: 0, momentum: 0.2, smooth: 0.3, curve: 1, sense: 1, integrate: true, mode: 1, return_time: 1.0, sharpen: 0, scale: 1, rolloff: 0 },
      'output', [
        { key: 'input', value: 1, frames: 40 },
        { frames: 70 },    // cumulative 110 frames: 0.44-2.2 s
        { frames: 140 },   // cumulative 250 frames: 1.0-5 s
        { frames: 750 },   // cumulative 1000 frames: 4-20 s — long past the fall
      ]);
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeLessThan(15);  // rests at 0 now
    const arc = [1, 2, 3].map(i => r.phases[i].trace('out').averageColor().r);
    expect(Math.max(...arc)).toBeGreaterThan(180);
    // ...and the ball comes all the way home (exact 0, not an offset).
    expect(r.phases[4].trace('out').averageColor().r).toBeLessThan(15);
  });

  it('slow motion reads a partial level, and curve < 1 lifts it (delicacy)', async () => {
    // A small 0.1 step against a 0.3 s window reads rate 0.1/0.3 ≈ 0.33 for
    // the window duration — dt-invariant ONCE the ring holds ≥ window of
    // history, hence the long phase-1 wait (100 frames ≥ 0.4 s at 4 ms).
    // curve 1 → 0.33 (~85); curve 0.5 → √0.33 ≈ 0.58 (~147). Neither pegs:
    // this is the "any motion spikes to max" regression guard.
    const slow = (id: string, curve: number) => runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: id,
              sketch: build({ input: 0.5, momentum: 0, smooth: 0.3, curve, sense: 1, integrate: false, sharpen: 0, scale: 1, rolloff: 0 }, 'output') },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 100, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'input', value: 0.6 }],
          waitFrames: 5, captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });
    const c1 = await slow('mo_crv1', 1);
    const c05 = await slow('mo_crv05', 0.5);
    expect(c1.success && c05.success).toBe(true);
    const r1 = c1.phases[1].trace('out').averageColor().r;
    const r05 = c05.phases[1].trace('out').averageColor().r;
    expect(r1).toBeGreaterThan(50);
    expect(r1).toBeLessThan(120);     // NOT pegged: true rate, not a patch spike
    expect(r05).toBeGreaterThan(115);
    expect(r05).toBeLessThan(180);
    expect(r05).toBeGreaterThan(r1 + 30);
  });

  it('scale boosts the output, and rolloff softens the ceiling under drive', async () => {
    // Same slow 0.1-step rig as the delicacy test (raw reading 0.33). Three
    // runs, varying only the output stage:
    //   scale 2, rolloff 0 → 0.67 (~170): linear gain, no clipping yet.
    //   scale 4, rolloff 0 → hard-clamped 1.0 (255).
    //   scale 4, rolloff 1 → tanh(1.33) ≈ 0.87 (~222): driven but not pinned.
    const slow = (id: string, scale: number, rolloff: number) => runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: id,
              sketch: build({ input: 0.5, momentum: 0, smooth: 0.3, curve: 1, sense: 1, integrate: false, sharpen: 0, scale, rolloff }, 'output') },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 100, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'input', value: 0.6 }],
          waitFrames: 5, captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });
    const lin = await slow('mo_scl2', 2, 0);
    const hard = await slow('mo_scl4h', 4, 0);
    const soft = await slow('mo_scl4s', 4, 1);
    expect(lin.success && hard.success && soft.success).toBe(true);
    const rLin = lin.phases[1].trace('out').averageColor().r;
    const rHard = hard.phases[1].trace('out').averageColor().r;
    const rSoft = soft.phases[1].trace('out').averageColor().r;
    expect(rLin).toBeGreaterThan(140);
    expect(rLin).toBeLessThan(205);
    expect(rHard).toBeGreaterThan(245);           // hard ceiling: pinned
    expect(rSoft).toBeGreaterThan(195);           // driven...
    expect(rSoft).toBeLessThan(rHard - 15);       // ...but rolled off, not pinned
  });

  it('sharpen overshoots a transition, hardening the attack', async () => {
    // Slow 0.1-step rig (steady reading 0.33). Captured 3 frames (12-60 ms)
    // after the step, the sharpen reference lowpass (tau 80 ms) still lags:
    // sharpen 2 reads 0.33 + 2·(0.33 − lp) ≈ 0.64..0.90 (~163-229), vs the
    // un-sharpened 0.33 (~85) — the transition overshoots well above its
    // steady level.
    const step = (id: string, sharpen: number) => runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: id,
              sketch: build({ input: 0.5, momentum: 0, smooth: 0.3, curve: 1, sense: 1, integrate: false, sharpen, scale: 1, rolloff: 0 }, 'output') },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 100, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'input', value: 0.6 }],
          waitFrames: 3, captureTraceIds: ['out'] },
      ],
      dumpName: id,
    });
    const plain = await step('mo_shp0', 0);
    const sharp = await step('mo_shp2', 2);
    expect(plain.success && sharp.success).toBe(true);
    const rPlain = plain.phases[1].trace('out').averageColor().r;
    const rSharp = sharp.phases[1].trace('out').averageColor().r;
    expect(rPlain).toBeLessThan(120);              // steady partial reading
    expect(rSharp).toBeGreaterThan(140);           // overshot the steady level
    expect(rSharp).toBeGreaterThan(rPlain + 40);
  });

  it('the signed velocity output reads mid at rest, high moving up, low moving down', async () => {
    const r = await runPhases('mo_vel',
      { input: 0.5, momentum: 0, smooth: 0.3, curve: 1, sense: 1, integrate: false, sharpen: 0, scale: 1, rolloff: 0 }, 'velocity', [
        { key: 'input', value: 1, frames: 5 },   // clamped +1 → max
        { frames: 150 },                         // 0.6-3 s: past the window → exact 0 → mid
        { key: 'input', value: 0, frames: 5 },   // clamped -1 → min
      ]);
    expect(r.success).toBe(true);
    const rest = r.phases[0].trace('out').averageColor();
    expect(Math.abs(rest.r - 128)).toBeLessThanOrEqual(10);  // signed 0 folds to mid
    expect(rest.r).toBe(rest.g);
    expect(rest.r).toBe(rest.b);
    expect(r.phases[1].trace('out').averageColor().r).toBeGreaterThan(200);
    expect(Math.abs(r.phases[2].trace('out').averageColor().r - 128)).toBeLessThanOrEqual(10);
    expect(r.phases[3].trace('out').averageColor().r).toBeLessThan(50);
  });
});
