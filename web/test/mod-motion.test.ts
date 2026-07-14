import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.shaper.motion shaper node — a normalized differentiator
 * (how fast is the input moving) with catch-fast/coast-slow momentum and an
 * optional Activity/Throw integrator. `output` is unsigned speed (or the
 * integrator level); `velocity` is the signed post-momentum velocity.
 *
 * Probe chain: white solid → motion → brightness_contrast, with the chosen
 * output wired into bc.brightness (combine:'replace'): with contrast -0.5 on
 * white input, display ≈ clamp01(raw)*255 for the unsigned output, and the
 * SIGNED velocity folds -1/0/+1 → 0/128/255 (tap_mod.h Replace fold).
 *
 * Timing lever: the harness runs real rAF dt, and headless rAF is NOT
 * vsync-locked — measured anywhere from ~4 to ~16 ms/frame. A one-frame
 * setParam step of Δ=1 with smooth 0.08 / sense 1 spikes the rate pole to
 * Δ/smooth ≈ 12× full scale REGARDLESS of dt (a·inst ≈ (dt/τ)·(Δ/dt)), so
 * "pegged" captures a few frames after a step are dt-invariant. Decay
 * captures are NOT: every wait below is sized so its assertion holds across
 * dt ∈ [4 ms, 20 ms] (worst case at both ends checked in comments). Params
 * are always set explicitly so retuning shipped defaults can't break the suite.
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
        sketch: build({ input: 0.7, momentum: 1, smooth: 0.08, sense: 1 }, 'output') }],
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
      { input: 0, momentum: 0, smooth: 0.08, sense: 1 }, 'output', [
        { key: 'input', value: 1, frames: 5 },   // pegged: pole ≈12× at any dt
        { frames: 120 },                         // ≥6 smoothing taus even at 4 ms frames
      ]);
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeLessThan(15);
    expect(r.phases[1].trace('out').averageColor().r).toBeGreaterThan(200);
    expect(r.phases[2].trace('out').averageColor().r).toBeLessThan(40);
  });

  it('momentum holds the speed reading long after the flick', async () => {
    // Identical flick, captured 90 frames (0.36-1.8 s across dt range) later:
    // momentum 0 has decayed through the 0.08 s pole (≤ 0.12 at 4 ms frames);
    // momentum 1 (coast tau 2 s) still holds e^-0.18..e^-0.9 ≈ 0.41..0.84.
    const flick = (id: string, momentum: number) => runPhases(id,
      { input: 0, momentum, smooth: 0.08, sense: 1 }, 'output', [
        { key: 'input', value: 1, frames: 90 },
      ]);
    const m0 = await flick('mo_m0', 0);
    const m1 = await flick('mo_m1', 1);
    expect(m0.success && m1.success).toBe(true);
    const r0 = m0.phases[1].trace('out').averageColor().r;
    const r1 = m1.phases[1].trace('out').averageColor().r;
    expect(r0).toBeLessThan(60);
    expect(r1).toBeGreaterThan(90);
    expect(r1).toBeGreaterThan(r0 + 60);
  });

  it('Activity mode charges while wiggling and drains at rest', async () => {
    const r = await runPhases('mo_act',
      { input: 0, momentum: 0, smooth: 0.08, sense: 1, integrate: true, mode: 0, decay: 0.6 },
      'output', [
        { key: 'input', value: 1, frames: 20 },
        { key: 'input', value: 0, frames: 20 },
        { key: 'input', value: 1, frames: 20 },
        { key: 'input', value: 0, frames: 20 },  // 0.32-1.6 s of near-pegged |v|
        { frames: 300 },                         // 1.2-6 s idle: ≥2 decay taus
      ]);
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeLessThan(15);
    // Charge: acc = 1.8(1-e^(-t/0.6)) ≈ 0.74 at the 4 ms worst case, clamped
    // 1.0 at slower frames.
    expect(r.phases[4].trace('out').averageColor().r).toBeGreaterThan(150);
    expect(r.phases[5].trace('out').averageColor().r).toBeLessThan(45);
  });

  it('Throw mode rests at center, gets flung by a flick, and leaks back home', async () => {
    const r = await runPhases('mo_throw',
      { input: 0.5, momentum: 0.5, smooth: 0.08, sense: 1, integrate: true, mode: 1, return_time: 1.0 },
      'output', [
        { key: 'input', value: 1, frames: 30 },  // up-flick: 0.12-0.6 s of displacement
        { frames: 600 },                         // 2.4-12 s idle: ≥2.4 return taus
      ]);
    expect(r.success).toBe(true);
    const rest = r.phases[0].trace('out').averageColor().r;
    expect(Math.abs(rest - 128)).toBeLessThanOrEqual(15);   // seeded at 0.5
    // Displacement ≥ 0.5 + 1.5·0.12 ≈ 0.68 at the 4 ms worst case.
    expect(r.phases[1].trace('out').averageColor().r).toBeGreaterThan(160);
    const home = r.phases[2].trace('out').averageColor().r;
    expect(Math.abs(home - 128)).toBeLessThanOrEqual(18);
  });

  it('the signed velocity output reads mid at rest, high moving up, low moving down', async () => {
    const r = await runPhases('mo_vel',
      { input: 0.5, momentum: 0, smooth: 0.08, sense: 1 }, 'velocity', [
        { key: 'input', value: 1, frames: 5 },   // clamped +1 → max
        { frames: 150 },                         // ≥7 smoothing taus: settle to 0 → mid
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
