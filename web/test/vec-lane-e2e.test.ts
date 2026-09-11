/**
 * Dual-backend e2e: a wire and an automation curve each driving ONE COMPONENT
 * of the same vector field, without touching each other or the third.
 *
 * One clip, one `source.solid_color` whose `color` is an rgb float3 authored to
 * a dark grey, plus:
 *   - RED   (lane 0) ← a wire from an LFO
 *   - GREEN (lane 1) ← nothing at all
 *   - BLUE  (lane 2) ← an automation curve ramping 0 → 1 across the clip
 *
 * Sampled at two beats, that pins every claim the feature makes at once:
 * blue RAMPS (the per-lane curve reaches the right component), green stays at
 * its authored value at both (neither modulation leaked sideways), and red is
 * driven away from the authored value by the wire — while the ramp on blue
 * leaves it alone.
 *
 * It also pins the original bug from the other direction: before this, anything
 * modulating a float3 wrote a bare number, the effect's patchVec3 read no
 * components, and the fill went black. A black frame fails every assertion here.
 *
 * Running it on both backends is what proves executor.wasm and the native
 * executor agree — this is one shared C++ implementation, and a divergence
 * would mean the web preview and a Resolume render disagree about a colour.
 *
 *   npx jest vec-lane-e2e
 */

import { forEachBackend, runCompScenario } from './comp-test-helpers';
import { LFO_1HZ, mkClip, mkComposition, mkDevice, mkTrack } from './fixtures/comp-docs';

/** The authored colour, before anything modulates it. */
const AUTHORED = [0.1, 0.1, 0.1];
const AUTHORED_8BIT = Math.round(AUTHORED[1] * 255);   // ≈ 26

/** Two sample points inside the clip: near its start and near its end. */
const EARLY = 0.5;
const LATE = 7.5;

function laneDoc() {
  const devices = [
    mkDevice('d-lfo', 'mod.source.lfo', LFO_1HZ),
    mkDevice('d-fill', 'source.solid_color', { color: AUTHORED }),
  ];
  return mkComposition([
    mkTrack('t-vec', [
      mkClip('c-vec', 0, 8, devices, {
        // Clip wires address devices by their DEVICE id.
        sketch: {
          devices,
          wires: [{
            id: 'w-red',
            src: { instanceKey: 'd-lfo', field: 'output' },
            dest: { instanceKey: 'd-fill', field: 'color', lane: 0 },
            combine: 'replace',
            magnitude: 'unsigned',
          }],
        },
        automation: [{
          id: 'a-blue',
          targetDeviceId: 'd-fill',
          targetField: 'color',
          targetLane: 2,
          label: 'Fill · color B',
          points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          combine: 'replace',
          magnitude: 'unsigned',
        }],
      }),
    ]),
  ]);
}

forEachBackend((backend) => {
describe(`Per-component vector modulation, dual-backend (${backend})`, () => {
  jest.setTimeout(180_000);

  it('a curve on blue and a wire on red leave each other, and green, alone', async () => {
    const run = await runCompScenario({
      doc: laneDoc(),
      ops: [{ seek: EARLY }, { capture: 'early' }, { seek: LATE }, { capture: 'late' }],
    });
    const early = run.capture('early').centerPixel();
    const late = run.capture('late').centerPixel();

    // Not black: something reached the effect as an ARRAY. (The old failure
    // wrote a bare float, the effect read no components, and the fill went to
    // the origin — every assertion below would fail on that, but this one says
    // why.)
    expect(early.r + early.g + early.b).toBeGreaterThan(10);

    // BLUE ramps: the lane-2 curve runs 0 → 1 across the clip.
    expect(late.b).toBeGreaterThan(early.b + 40);
    expect(early.b).toBeLessThan(90);
    expect(late.b).toBeGreaterThan(160);

    // GREEN is untouched at BOTH samples — neither the ramp on blue nor the
    // wire on red leaked into the lane nobody addressed.
    expect(Math.abs(early.g - AUTHORED_8BIT)).toBeLessThan(12);
    expect(Math.abs(late.g - AUTHORED_8BIT)).toBeLessThan(12);

    // RED is driven by its wire, away from the authored value, and does not
    // follow blue's ramp.
    expect(Math.abs(early.r - AUTHORED_8BIT)).toBeGreaterThan(20);
    expect(Math.abs(late.r - AUTHORED_8BIT)).toBeGreaterThan(20);
  });

  it('with neither wire nor curve, every component keeps its authored value', async () => {
    // The control: without it, "green stayed at 26" above could just as well
    // mean nothing in the scenario did anything at all.
    const doc = laneDoc() as { tracks: Array<Record<string, any>> };
    doc.tracks[0].clips[0].automation = [];
    doc.tracks[0].clips[0].sketch.wires = [];

    const run = await runCompScenario({
      doc: doc as unknown as Record<string, unknown>,
      ops: [{ seek: LATE }, { capture: 'plain' }],
    });
    const px = run.capture('plain').centerPixel();
    for (const ch of [px.r, px.g, px.b]) {
      expect(Math.abs(ch - AUTHORED_8BIT)).toBeLessThan(12);
    }
  });
});
});
