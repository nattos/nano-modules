/**
 * Dual-backend e2e: TRANSPORT-CONTROLLER EFFECTS.
 *
 * A clip's transport section is a separate mini-sketch whose controller devices
 * retime the clip's content. The engine runs it as a PRE-PASS
 * (`transportResolve`, between update and render) and reads each driven clip's
 * published `transport_*` scalars into the times channel, which is what the
 * decode pump and the streams positions consume.
 *
 * The web-only ancestor (`arrangement-transport.test.ts`) sampled the store's
 * `pluginStates` mirror over ~1.2 s of WALL CLOCK and asserted a rate within a
 * ±20% band, because rAF pacing is variable in headless. Here the runner is
 * fixed-step on both backends, so the published time can be checked against the
 * exact elapsed transport seconds instead of a tolerance band — and the same
 * assertion runs natively, where `CompExecutor::transportResolve` is the code
 * under test rather than the web engine's mirror of it.
 *
 *   npx jest arrangement-transport-parity
 */

import { forEachBackend, runCompScenario } from './comp-test-helpers';
import { transportTimeDoc } from './fixtures/comp-docs';

/** 120 BPM ⇒ 0.5 transport-seconds per beat (the fixture's meta.baseBPM). */
const SEC_PER_BEAT = 0.5;
const DT = 1 / 60;

forEachBackend((backend) => {
describe(`Transport-controller effects, dual-backend (${backend})`, () => {
  jest.setTimeout(180_000);

  it('publishes content time at the controller rate', async () => {
    const run = await runCompScenario({
      doc: transportTimeDoc(2),
      ops: [
        { seek: 0 },
        // The section instance has to EXIST before it can publish: the row is
        // invalid (null) on the frame the structure was built. Two frames of
        // lead-in, then sample the interval between two captures.
        { play: { frames: 2, dtSec: DT } },
        { capture: 'a' },
        { play: { frames: 60, dtSec: DT } },
        { capture: 'b' },
      ],
    });

    const a = run.capture('a');
    const b = run.capture('b');

    // The row is live and valid at both ends.
    expect(a.transportTime('c-1')).not.toBeNull();
    expect(b.transportTime('c-1')).not.toBeNull();

    // Content time advances at 2x transport seconds. Fixed-step means the
    // elapsed transport time is EXACT — the beat delta is the ground truth, so
    // this needs no pacing tolerance, only float slack.
    const transportSec = (b.positionBeat - a.positionBeat) * SEC_PER_BEAT;
    expect(transportSec).toBeGreaterThan(0.9);   // the play block really ran
    expect(b.transportTime('c-1')! - a.transportTime('c-1')!)
      .toBeCloseTo(transportSec * 2, 3);

    // The controller reports that rate itself, and is playing.
    expect(b.transport['c-1'].rate).toBeCloseTo(2, 3);
    expect(b.transport['c-1'].active).toBe(1);
    expect(b.transport['c-1'].ended).toBe(0);
  });

  it('is identity on pixels', async () => {
    // A controller retimes content; it must never touch the picture. The clip
    // under it is solid red, so the composite is still solid red.
    const run = await runCompScenario({
      doc: transportTimeDoc(2),
      ops: [{ seek: 0 }, { play: { frames: 10, dtSec: DT } }, { capture: 'px' }],
    });
    const px = run.capture('px');
    expect(px.hasContent).toBe(true);
    expect(px.centerPixel().r).toBeGreaterThan(120);
    expect(px.centerPixel().g).toBeLessThan(40);
    expect(px.centerPixel().b).toBeLessThan(40);
    // Flat: no gradient, no darkening at the edges.
    expect(px.lumaSpread()).toBeLessThan(2);
  });

  it('freezes the published time while the transport is paused', async () => {
    // `step` paces frames with the transport PAUSED — the published time is
    // derived from the clip's elapsed PARENT seconds, so a frozen playhead must
    // freeze it even though host time keeps advancing. (A `play` block can't
    // ask this question: it advances the playhead by construction.)
    const run = await runCompScenario({
      doc: transportTimeDoc(2),
      ops: [
        { seek: 0 },
        { play: { frames: 30, dtSec: DT } },
        { capture: 'paused-a' },
        { step: { frames: 30, dtSec: DT } },
        { capture: 'paused-b' },
      ],
    });

    const a = run.capture('paused-a');
    const b = run.capture('paused-b');
    expect(a.transportTime('c-1')).not.toBeNull();
    // The playhead didn't move...
    expect(b.positionBeat).toBeCloseTo(a.positionBeat, 6);
    // ...so neither did the published content time.
    expect(b.transportTime('c-1')!).toBeCloseTo(a.transportTime('c-1')!, 6);
  });

  it('a slower controller publishes proportionally less time', async () => {
    // Guards the direction of the rate mapping: `speed` scales content time,
    // it is not a divisor. Same op list, half the speed, half the advance.
    const play = async (speed: number) => {
      const run = await runCompScenario({
        doc: transportTimeDoc(speed),
        ops: [
          { seek: 0 },
          { play: { frames: 2, dtSec: DT } },
          { capture: 'a' },
          { play: { frames: 60, dtSec: DT } },
          { capture: 'b' },
        ],
      });
      return run.capture('b').transportTime('c-1')! - run.capture('a').transportTime('c-1')!;
    };

    const fast = await play(2);
    const slow = await play(0.5);
    expect(slow).toBeGreaterThan(0);
    expect(fast / slow).toBeCloseTo(4, 2);
  });

  it('a clip with no transport section is not driven at all', async () => {
    // A MISSING row and an INVALID one mean different things: nothing drives
    // this clip, versus its section instance isn't live yet. The times channel
    // carries driven clips only.
    const doc = transportTimeDoc(2) as any;
    delete doc.tracks[0].clips[0].transport;
    const run = await runCompScenario({
      doc,
      ops: [{ seek: 0 }, { play: { frames: 10, dtSec: DT } }, { capture: 'none' }],
    });
    const cap = run.capture('none');
    expect(cap.transport['c-1']).toBeUndefined();
    expect(cap.hasContent).toBe(true);      // it still renders, just untimed
  });
});
});
