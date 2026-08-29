import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { EnginePhaseConfig } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for `mod.rig.three_planes` — the show controller for the Three Planes
 * stack. The ballistics themselves (meter fall, peak hold, flam envelopes, the
 * four camera moves) are pinned host-free by
 * native/tests/test_three_planes_rig.cpp; what only a real engine can check is
 * everything BETWEEN the card and its destination:
 *
 *   - the lit/unlit decision surviving as a value on a real wire,
 *   - the NORMALISATION contract (`elevation` goes out as deg/89,
 *     `plane_spacing` as units/1.5) surviving the executor's magnitude fold,
 *   - the COLOUR rails, which are the first computed vec3 output in the tree —
 *     everything else either takes colour in or relays an authored one.
 *
 * Probe for the scalar cases is the house one: white solid → rig → bc, with a
 * rig output wired into bc.brightness. An unsigned [0,1] source folds into
 * brightness's signed [-1,1] under auto/replace, and with contrast -0.5 on white
 * bc paints black at 0, mid grey at 0.5 and white at 1 — so the pixel reads the
 * rail directly.
 *
 * Every case is a STEADY state: a gate held at 1 pins the meter at its floor
 * regardless of frame pacing, so nothing here depends on how long a waitFrames
 * window actually took (see the e2e rAF-pacing note in the repo).
 */
describe('mod.rig.three_planes E2E', () => {
  jest.setTimeout(60000);

  // The real shipping bundle: it carries source.solid_color,
  // mod.rig.three_planes and color.tone.brightness_contrast. Passed explicitly
  // because the harness's legacy alias table doesn't know this id and would
  // resolve it to the testonly fork.
  const MODULES = ['com.nano.core'];

  /** Defaults that make each case a clean 0-or-1 read of the lit decision. */
  const CRISP = { emission_on: 1.0, emission_off: 0.0, flam_emission: 0.0 };

  // A fully lit floor does NOT read white. The emission rails carry a FRACTION
  // of Three Planes' emission range, and that range runs past fully lit — the
  // overdrive headroom the sweep's Bounce overshoots into — so Lit Level 1
  // publishes 1/1.5 of full scale and lands on 170, not 255. Every emission
  // read below goes through this; every other rail is a plain [0,1].
  const EMISSION_MAX = 1.5;
  const emissionGrey = (level: number) => 255 * level / EMISSION_MAX;
  const expectEmission = (r: number, level: number) => {
    expect(r).toBeGreaterThan(emissionGrey(level) - 22);
    expect(r).toBeLessThan(emissionGrey(level) + 22);
  };

  // solid(white) → rig → bc(brightness 1, contrast -0.5), one rig output wired
  // into bc.brightness. solid_color publishes no modulation, so the rig's
  // `sig_1` auto-connect has nothing to steal it with.
  const scalarSketch = (field: string, params: Record<string, unknown>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.rig.three_planes', instance_key: 'rig@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'rig@0', field },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const runScalar = (id: string, field: string, params: Record<string, unknown>) =>
    runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: id, sketch: scalarSketch(field, params) }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: id,
    });

  it('a held gate lights its own floor and everything under it', async () => {
    // Signal 2 names floor 2, so floors 1 and 2 light and floor 3 stays dark.
    const p = { ...CRISP, sig_2: 1.0 };
    const f1 = await runScalar('rig_fill_p1', 'plane1_emission', p);
    const f2 = await runScalar('rig_fill_p2', 'plane2_emission', p);
    const f3 = await runScalar('rig_fill_p3', 'plane3_emission', p);
    expect(f1.success && f2.success && f3.success).toBe(true);
    expectEmission(f1.trace('out').averageColor().r, 1.0);
    expectEmission(f2.trace('out').averageColor().r, 1.0);
    expect(f3.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('a floor above the meter stays dark', async () => {
    const r = await runScalar('rig_below', 'plane2_emission', { ...CRISP, sig_1: 1.0 });
    expect(r.success).toBe(true);
    expect(r.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('Allow Holes stops the tower filling in underneath', async () => {
    // Signal 3 names the top floor. Filled in, floor 1 lights under it; with
    // holes it does not, because nothing fired there.
    const filled = await runScalar('rig_holes_off', 'plane1_emission',
                                   { ...CRISP, sig_3: 1.0, allow_holes: false });
    const holed  = await runScalar('rig_holes_on', 'plane1_emission',
                                   { ...CRISP, sig_3: 1.0, allow_holes: true });
    expect(filled.success && holed.success).toBe(true);
    expectEmission(filled.trace('out').averageColor().r, 1.0);
    expect(holed.trace('out').averageColor().r).toBeLessThan(40);
    // The cap floor itself is exempt from the holes rule — it always shows.
    const cap = await runScalar('rig_holes_cap', 'plane3_emission',
                                { ...CRISP, sig_3: 1.0, allow_holes: true });
    expectEmission(cap.trace('out').averageColor().r, 1.0);
  });

  // THE NORMALISATION CONTRACT. `elevation` is published as a fraction of Three
  // Planes' 0..89 deg range, not as degrees, because a hand-drawn wire folds the
  // value into the DESTINATION field's range. A mid-range baseline is what
  // actually discriminates: if the card published degrees (or divided by the
  // wrong number) this would saturate white instead of landing on grey.
  it('elevation goes out as a fraction of the 0..89 deg range', async () => {
    const lo  = await runScalar('rig_elev_lo',  'elevation', { elevation_base: 0 });
    const mid = await runScalar('rig_elev_mid', 'elevation', { elevation_base: 44.5 });
    const hi  = await runScalar('rig_elev_hi',  'elevation', { elevation_base: 89 });
    expect(lo.success && mid.success && hi.success).toBe(true);
    expect(lo.trace('out').averageColor().r).toBeLessThan(40);
    expect(mid.trace('out').averageColor().r).toBeGreaterThan(100);
    expect(mid.trace('out').averageColor().r).toBeLessThan(156);
    expect(hi.trace('out').averageColor().r).toBeGreaterThan(215);
  });

  it('plane spacing goes out as a fraction of the 0..1.5 range', async () => {
    const mid = await runScalar('rig_space_mid', 'plane_spacing', { spacing_base: 0.75 });
    const hi  = await runScalar('rig_space_hi',  'plane_spacing', { spacing_base: 1.5 });
    expect(mid.success && hi.success).toBe(true);
    expect(mid.trace('out').averageColor().r).toBeGreaterThan(100);
    expect(mid.trace('out').averageColor().r).toBeLessThan(156);
    expect(hi.trace('out').averageColor().r).toBeGreaterThan(215);
  });

  // THE MOVE TRIGGERS. `show`/`sweep_up`/`glance`/`unfold` are event fields, and
  // the executor replays every stored value as a PatchReplace EVERY frame — so a
  // handler that fired on patch arrival would re-arm the move forever. The
  // rising edge is the defense, and this is where it is actually exercised:
  // fire once, watch the move run, then watch it EXPIRE while `show` is still
  // sitting at 1 in instance state.
  it('a move fires once on the rising edge and does not re-arm from the replay', async () => {
    // Orbit baseline at mid-scale so idle reads as grey, and the widest possible
    // swing so the start pose (baseline + 90 deg = 0.75 of a turn) is far from it.
    const params = { azimuth_base: 0.5, show_azimuth: 180.0, show_time: 0.25 };
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'rig_show', sketch: scalarSketch('orbit_azimuth', params) },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'rig_show' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // Fire it. One frame later the camera has popped to its start pose,
        // which the reversed polarity puts a quarter turn ABOVE the baseline.
        { commands: [{ type: 'setParam', sketchId: 'rig_show', colIdx: 0, chainIdx: 1, paramKey: 'show', value: 1 }],
          waitFrames: 1, captureTraceIds: ['out'] },
        // Wait out the move with `show` STILL 1 in state. It must expire and pop
        // back to the baseline; a replay-armed trigger would hold it out here.
        { commands: [], waitFrames: 150, captureTraceIds: ['out'] },
      ],
      dumpName: 'rig_show',
    });
    expect(r.success).toBe(true);
    const idleR = r.phases[0].trace('out').averageColor().r;
    const firedR = r.phases[1].trace('out').averageColor().r;
    const doneR = r.phases[2].trace('out').averageColor().r;
    expect(idleR).toBeGreaterThan(100);
    expect(idleR).toBeLessThan(156);
    expect(firedR).toBeGreaterThan(156);   // popped to the start pose
    expect(doneR).toBeGreaterThan(100);    // popped back to baseline
    expect(doneR).toBeLessThan(156);
  });

  // THE COLOUR RAILS. rig → solid_color.color, read straight off the sketch
  // output: a computed vec3 travelling a real wire. Vec rails carry components
  // whole, with no magnitude fold, so what the card computes is what lands.
  const colorSketch = (params: Record<string, unknown>, field = 'plane1_color'): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'mod.rig.three_planes', instance_key: 'rig@0', params },
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [0.0, 0.0, 0.0] } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'rig@0', field },
        dest: { instanceKey: 'src@0', field: 'color' }, combine: 'replace' },
    ],
  } as Sketch);

  const runColor = (id: string, params: Record<string, unknown>, field?: string) =>
    runEngineTest({
      width: 64, height: 64,
      modules: MODULES,
      commands: [{ type: 'createSketch', sketchId: id, sketch: colorSketch(params, field) }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: id,
    });

  it('a resting floor publishes the Secondary colour down a vec wire', async () => {
    // Nothing firing: floor 1 is neither the cap nor flamming, so it rests on
    // Secondary — violet (0.72, 0.35, 1.00).
    const r = await runColor('rig_col_rest', {});
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 184, g: 89, b: 255 }, 12);
  });

  it('the cap floor publishes the Highlight colour instead', async () => {
    // Signal 1 names floor 1, so floor 1 IS the cap and rests on Highlight —
    // cyan (0.30, 0.85, 1.00). Same wire, different colour: this is the whole
    // point of the card, and it only reads correctly if the rail is live.
    const r = await runColor('rig_col_cap', { sig_1: 1.0, flam_color: 0.0 });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 77, g: 217, b: 255 }, 12);
  });

  it('an authored colour input reaches the rails', async () => {
    // Drive Secondary to pure red and the resting floor must follow it — proof
    // the vec INPUT and the vec OUTPUT are both wired through, not defaults.
    const r = await runColor('rig_col_authored', { secondary_color: [1.0, 0.0, 0.0] });
    expect(r.success).toBe(true);
    r.trace('out').expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 12);
  });

  // --- Solid -----------------------------------------------------------------
  //
  // The mode with no reactivity: three lit floors, nothing listening. What the
  // engine adds over the host-free goldens is that `mode` really is reaching the
  // card as a select patch, and that the colour rails re-role in this mode.

  const SOLID = 1;

  it('Solid lights the top floor with nothing playing', async () => {
    // The same silent sketch reads dark under the meter and lit under Solid —
    // the one difference is the mode.
    const meter = await runScalar('rig_solid_off', 'plane3_emission', { ...CRISP });
    const solid = await runScalar('rig_solid_on',  'plane3_emission', { ...CRISP, mode: SOLID });
    expect(meter.success && solid.success).toBe(true);
    expect(meter.trace('out').averageColor().r).toBeLessThan(40);
    expectEmission(solid.trace('out').averageColor().r, 1.0);
  });

  it('Solid ignores the gates entirely', async () => {
    // Every channel pegged. Under the meter this would peg the tower and flam;
    // here the floors sit exactly at Lit Level and the meter rail reads 0.
    const p = { ...CRISP, mode: SOLID, emission_on: 0.5,
                sig_1: 1.0, sig_2: 1.0, sig_3: 1.0, sig_4: 1.0 };
    const floor = await runScalar('rig_solid_gates', 'plane1_emission', p);
    const meter = await runScalar('rig_solid_meter', 'meter', p);
    expect(floor.success && meter.success).toBe(true);
    // Lit Level 0.5, and nothing riding on top of it — no flam blip.
    expectEmission(floor.trace('out').averageColor().r, 0.5);
    // Nothing is being measured, so the meter rail reports nothing.
    expect(meter.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('Solid gives each floor its own colour', async () => {
    // bottom = Primary (magenta), middle = Highlight (cyan), top = Secondary
    // (violet) — three_planes' own plane defaults, so an untouched rig in this
    // mode reproduces the look the effect ships with.
    const p = { mode: SOLID };
    const p1 = await runColor('rig_solid_c1', p, 'plane1_color');
    const p2 = await runColor('rig_solid_c2', p, 'plane2_color');
    const p3 = await runColor('rig_solid_c3', p, 'plane3_color');
    expect(p1.success && p2.success && p3.success).toBe(true);
    p1.trace('out').expectPixelAt(32, 32, { r: 255, g: 56, b: 158 }, 12);
    p2.trace('out').expectPixelAt(32, 32, { r: 77, g: 217, b: 255 }, 12);
    p3.trace('out').expectPixelAt(32, 32, { r: 184, g: 89, b: 255 }, 12);
  });

  // THE END-OF-MOVE HOLD. Only the parked pose is asserted here: the exact
  // moment a hold expires is pinned host-free by the native goldens, and pacing
  // one out over a real rAF window (4-20 ms a frame in headless) would need
  // hundreds of frames to be safe. What the engine adds is that `hold_time`
  // reaches the card at all, and that the phase saturates instead of ending.
  it('Hold parks a move on its end pose past the travel time', async () => {
    // Travel 0.05 s, hold 3 s: any plausible 30-frame window lands inside the
    // hold and well past the travel, whatever the pacing does.
    const params = { azimuth_base: 0.5, show_azimuth: 180.0,
                     show_time: 0.05, hold_time: 3.0 };
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'rig_hold', sketch: scalarSketch('orbit_azimuth', params) },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'rig_hold' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // Fire it. The start pose is not sampled here — a 0.05 s travel is over
        // faster than a waitFrames window can reliably catch, and the pop-in is
        // already pinned by the rising-edge case above.
        { commands: [{ type: 'setParam', sketchId: 'rig_hold', colIdx: 0, chainIdx: 1, paramKey: 'show', value: 1 }],
          waitFrames: 1, captureTraceIds: ['out'] },
        // Long past the travel, and still parked — a quarter turn BELOW it.
        // Without the hold this would have popped back to the baseline grey.
        { commands: [], waitFrames: 30, captureTraceIds: ['out'] },
      ],
      dumpName: 'rig_hold',
    });
    expect(r.success).toBe(true);
    const idleR = r.phases[0].trace('out').averageColor().r;
    expect(idleR).toBeGreaterThan(100);
    expect(idleR).toBeLessThan(156);
    expect(r.phases[2].trace('out').averageColor().r).toBeLessThan(100);
  });

  // SWEEP START. The wind-up that gives Sweep Up an entry pop it otherwise
  // doesn't have. Sampled one frame in, with a long travel, so the reading is
  // the start POSE and not a point on the curve — which keeps it independent of
  // how long a frame actually took. (The ease curve's shape is pinned natively
  // instead, for the opposite reason: it can only be read mid-travel, and e2e
  // frame pacing can't hold a fraction of the travel steady.)
  it('Sweep Start dips the deck at the top of the move', async () => {
    const base = { elevation_base: 44.5, sweep_time: 3.0, sweep_target: 89.0 };
    const fire = (id: string, params: Record<string, unknown>) =>
      runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: MODULES,
        phases: [
          { commands: [
              { type: 'createSketch', sketchId: id, sketch: scalarSketch('elevation', params) },
              { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
            ],
            waitFrames: 20, captureTraceIds: ['out'] },
          { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1, paramKey: 'sweep_up', value: 1 }],
            waitFrames: 1, captureTraceIds: ['out'] },
        ],
        dumpName: id,
      });

    // 0: starts ON the baseline, so firing changes nothing yet.
    const flat = await fire('rig_sweep_flat', { ...base, sweep_start: 0 });
    // −44.5 deg off a 44.5 deg baseline puts the start pose at 0 — full down.
    const dip = await fire('rig_sweep_dip', { ...base, sweep_start: -44.5 });
    expect(flat.success && dip.success).toBe(true);

    for (const r of [flat, dip]) {
      const idleR = r.phases[0].trace('out').averageColor().r;
      expect(idleR).toBeGreaterThan(100);
      expect(idleR).toBeLessThan(156);
    }
    const flatFired = flat.phases[1].trace('out').averageColor().r;
    const dipFired = dip.phases[1].trace('out').averageColor().r;
    expect(flatFired).toBeGreaterThan(100);   // no entry pop without a wind-up
    expect(dipFired).toBeLessThan(40);        // and a deep one with it
  });

  it('a move still runs in Solid', async () => {
    // The moves fly the camera and the mode paints the tower, so they compose.
    // Same swing as the rising-edge case above, with the meter switched off.
    const params = { mode: SOLID, azimuth_base: 0.5, show_azimuth: 180.0, show_time: 0.25 };
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'rig_solid_show', sketch: scalarSketch('orbit_azimuth', params) },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'rig_solid_show' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: 'rig_solid_show', colIdx: 0, chainIdx: 1, paramKey: 'show', value: 1 }],
          waitFrames: 1, captureTraceIds: ['out'] },
        { commands: [], waitFrames: 150, captureTraceIds: ['out'] },
      ],
      dumpName: 'rig_solid_show',
    });
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeGreaterThan(100);
    expect(r.phases[1].trace('out').averageColor().r).toBeGreaterThan(156);
    expect(r.phases[2].trace('out').averageColor().r).toBeGreaterThan(100);
    expect(r.phases[2].trace('out').averageColor().r).toBeLessThan(156);
  });

  // ------------------------------------------------------------------ Sweep
  // The knob's DYNAMICS are pinned host-free (native/tests, which owns the
  // clock a motion estimator needs). What only a real engine shows is that a
  // patched value reaches the estimator at all, and that the position law
  // lands on the emission rails rather than somewhere else.

  /** Solid, one floor fully lit, flicker off — a clean read of the dimmer. */
  const SWEPT = { mode: 1, emission_on: 1.0, sweep_flicker: 0 };

  it('the deadzone keeps a knob near home from touching the tower', async () => {
    // Default deadzone is 0.45 of each half, so 0.70 is still inside it and
    // must read EXACTLY as home does. This is the whole point of the law:
    // riding the knob around centre changes nothing.
    const home = await runScalar('rig_sweep_home', 'plane1_emission',
                                 { ...SWEPT, sweep: 0.5 });
    const near = await runScalar('rig_sweep_near', 'plane1_emission',
                                 { ...SWEPT, sweep: 0.70 });
    expect(home.success && near.success).toBe(true);
    expectEmission(home.trace('out').averageColor().r, 1.0);
    expectEmission(near.trace('out').averageColor().r, 1.0);
  });

  it('either extreme fades the tower to black', async () => {
    const top = await runScalar('rig_sweep_top', 'plane1_emission',
                                { ...SWEPT, sweep: 1.0 });
    const bottom = await runScalar('rig_sweep_bottom', 'plane1_emission',
                                   { ...SWEPT, sweep: 0.0 });
    expect(top.success && bottom.success).toBe(true);
    // Signed in concept, unsigned in magnitude: both ends are the same
    // gesture, so they must land on the same picture.
    expect(top.trace('out').averageColor().r).toBeLessThan(40);
    expect(bottom.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('the knob goes out verbatim for the glints', async () => {
    // Three Planes throws glints from the GESTURE, not from a level, so what
    // crosses this wire is the knob itself — untouched by the envelope that
    // shapes Sweep Speed, and readable at rest.
    const still = await runScalar('rig_sweepout_hi', 'sweep_out',
                                  { ...SWEPT, sweep: 0.9 });
    const mid = await runScalar('rig_sweepout_mid', 'sweep_out',
                                { ...SWEPT, sweep: 0.5 });
    expect(still.success && mid.success).toBe(true);
    expect(still.trace('out').averageColor().r).toBeGreaterThan(215);
    const midR = mid.trace('out').averageColor().r;
    expect(midR).toBeGreaterThan(100);
    expect(midR).toBeLessThan(156);
  });

  it('a knob nobody has moved reads no speed', async () => {
    // Including one parked well off centre: the rail reports MOTION, and a
    // stationary knob is not moving however far from home it is parked.
    const still = await runScalar('rig_speed_still', 'sweep_speed',
                                  { ...SWEPT, sweep: 0.9 });
    expect(still.success).toBe(true);
    expect(still.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('moving the knob on a real wire reads as speed', async () => {
    // The leg the native goldens cannot reach: a patched `sweep` actually
    // reaching the estimator. Decay is stretched to 2 s so the reading does
    // not depend on how long the sampling window took.
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'rig_speed', sketch:
                scalarSketch('sweep_speed', { ...SWEPT, sweep: 0.5, sweep_decay: 2.0 }) },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'rig_speed' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // A jump of 0.4 in one frame is far past Full Scale, so the meter pegs.
        { commands: [{ type: 'setParam', sketchId: 'rig_speed', colIdx: 0,
                       chainIdx: 1, paramKey: 'sweep', value: 0.9 }],
          waitFrames: 2, captureTraceIds: ['out'] },
      ],
      dumpName: 'rig_speed',
    });
    expect(r.success).toBe(true);
    expect(r.phases[0].trace('out').averageColor().r).toBeLessThan(40);
    expect(r.phases[1].trace('out').averageColor().r).toBeGreaterThan(150);
  });

  // --- The bounce ---------------------------------------------------------
  // How far the light runs ahead of the knob, and how it springs back, is
  // pinned frame by frame at an exact dt in the native goldens. What only a
  // real engine can show is the leg those cannot reach: a patched Bounce
  // actually reaching the spring, on a knob moved over a real wire. So these
  // two ask only for the SIGN and the DIRECTION, never for a magnitude — the
  // lead is velocity-driven and engine frames are wall-clock.

  it('a knob thrown back home overshoots past fully lit, then springs onto it',
     async () => {
    // The gesture, end to end, at the shipping default: one frame from the
    // extreme to home, which is what a stepping encoder actually sends when
    // you slam it. The tower has to land HARDER than it normally sits and then
    // settle back — not merely get there a frame sooner.
    const slamHome = (id: string, bounce: number | null) => {
      const phases: EnginePhaseConfig[] = [
        { commands: [
            { type: 'createSketch', sketchId: id, sketch:
                scalarSketch('plane1_emission',
                             { ...SWEPT, sweep: 1.0,
                               ...(bounce === null ? {} : { sweep_bounce: bounce }) }) },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: id } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        { commands: [{ type: 'setParam', sketchId: id, colIdx: 0, chainIdx: 1,
                       paramKey: 'sweep', value: 0.5 }],
          waitFrames: 1, captureTraceIds: ['out'] },
      ];
      // One frame per phase through the swing. WHEN the spring crosses is a
      // matter of frame pacing, so nothing below reads a particular frame —
      // only the extremes over the whole window.
      for (let i = 0; i < 12; ++i)
        phases.push({ commands: [], waitFrames: 1, captureTraceIds: ['out'] });
      phases.push({ commands: [], waitFrames: 60, captureTraceIds: ['out'] });
      return runEngineMultiPhaseTest(
        { width: 64, height: 64, modules: MODULES, phases, dumpName: id });
    };
    const swing = (r: Awaited<ReturnType<typeof slamHome>>) =>
      Array.from({ length: 13 }, (_, i) => r.phases[i + 1].trace('out').averageColor().r);

    const plain = await slamHome('rig_bounce_off', 0);
    const bouncy = await slamHome('rig_bounce_on', null);   // the default
    expect(plain.success && bouncy.success).toBe(true);

    // Parked at the extreme, both are black.
    expect(plain.phases[0].trace('out').averageColor().r).toBeLessThan(40);
    expect(bouncy.phases[0].trace('out').averageColor().r).toBeLessThan(40);

    // Bounce dialled out relights straight onto the base and stays there —
    // the position law and nothing else, every frame of the way.
    for (const v of swing(plain)) expectEmission(v, 1.0);

    // With it on, the landing goes PAST the base — into the emission overdrive
    // Three Planes' range keeps above fully lit, which is the whole reason
    // that headroom exists...
    expect(Math.max(...swing(bouncy))).toBeGreaterThan(emissionGrey(1.0) + 30);
    // ...and then springs back down THROUGH it before settling. A tower that
    // only ever arrived early would have no dip.
    expect(Math.min(...swing(bouncy))).toBeLessThan(emissionGrey(1.0) - 8);

    // Both end on the base. A spring that crept would leave the tower a hair
    // off its own dimmer for ever.
    expectEmission(plain.phases[14].trace('out').averageColor().r, 1.0);
    expectEmission(bouncy.phases[14].trace('out').averageColor().r, 1.0);
  });

  it('the same throw OUTWARD does not swell at all', async () => {
    // Going out is a blackout, and a blackout that brightens before it falls
    // is a fault rather than a gesture. Same one frame, Bounce at maximum —
    // and the tower lands on the position law dead on.
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: MODULES,
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'rig_bounce_out', sketch:
                scalarSketch('plane1_emission',
                             { ...SWEPT, sweep: 0.5, sweep_bounce: 1 }) },
            { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'rig_bounce_out' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        // 0.8625 is half a throw past the deadzone, where the position law
        // reads exactly half.
        { commands: [{ type: 'setParam', sketchId: 'rig_bounce_out', colIdx: 0,
                       chainIdx: 1, paramKey: 'sweep', value: 0.8625 }],
          waitFrames: 5, captureTraceIds: ['out'] },
      ],
      dumpName: 'rig_bounce_out',
    });
    expect(r.success).toBe(true);
    expectEmission(r.phases[0].trace('out').averageColor().r, 1.0);
    expectEmission(r.phases[1].trace('out').averageColor().r, 0.5);
  });
});
