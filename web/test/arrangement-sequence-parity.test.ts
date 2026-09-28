/**
 * Dual-backend e2e: a SEQUENCE clip renders its interior.
 *
 * A sequence clip owns a mini-timeline in its own addressable lane, walked by an
 * interior clock that is NOT the arrangement clock. Three things this pins, all
 * of which fail silently (black or transparent, no error):
 *
 *   1. The interior is BUILT, not merely contained — the live sub-clip's device
 *      instance appears in the composite chain. `Builder::push` drops duplicate
 *      instance keys, so a bad clone renders nothing and says nothing.
 *   2. It reaches the frame: the pixels are the live sub-clip's, not the
 *      backdrop's.
 *   3. BOTH sub-clips do (1) and (2) as the interior clock crosses. The
 *      "second interior clip is sometimes transparent" regression was N interior
 *      clips all reading as live at once and racing one decoder.
 *
 * The sub-clips are DIFFERENT COLOURS on purpose: which one is live is then
 * readable from the pixels alone, independently of the chain keys, so (1) and
 * (2) can't both be satisfied by the same bug.
 *
 * The ⌘J Consolidate / ⇧⌘J Uncollapse legs stay in the web-only suite: those are
 * store commands, and the runners deliberately keep the store out of the parity
 * path. What is portable — and what actually broke twice — is the engine's
 * treatment of the resulting document, which is what this asserts.
 *
 *   npx jest arrangement-sequence-parity
 */

import { forEachBackend, runCompScenario } from './comp-test-helpers';
import { sequenceDoc, videoSequenceDoc } from './fixtures/comp-docs';

/** The sequence clip spans [40, 48) with interior clips at 0..4 and 4..8, so
 *  the interior clock runs 1:1 with the arrangement clock offset by 40. */
const IN_A = 41;
const IN_B = 45;

/** Video scenarios need at least two frames after a seek: both runners pump
 *  BEFORE stepping, so the first frame renders what the PREVIOUS one decoded. */
const SETTLE = { play: { frames: 2, dtSec: 1 / 60 } };

const hasClip = (keys: string[], clipId: string) => keys.some((k) => k.includes(clipId));

forEachBackend((backend) => {
describe(`Sequence clips, dual-backend (${backend})`, () => {
  jest.setTimeout(180_000);

  it('builds and renders the live interior sub-clip, and only that one', async () => {
    const run = await runCompScenario({
      doc: sequenceDoc(),
      ops: [{ seek: IN_A }, { capture: 'a' }, { seek: IN_B }, { capture: 'b' }],
    });

    const a = run.capture('a');
    expect(a.hasContent).toBe(true);
    // (1) built: the interior device is in the chain, and its sibling is not.
    expect(hasClip(a.chainKeys, 'sub-a')).toBe(true);
    expect(hasClip(a.chainKeys, 'sub-b')).toBe(false);
    // (2) rendered: the frame is sub-a's red, not a stand-in or the backdrop.
    a.expectPixelAt(32, 32, { r: 255, g: 0, b: 0 }, 2);

    // (3) crossing the interior clock swaps the roles exactly — the leg where
    // "the first always renders, the second sometimes" showed up.
    const b = run.capture('b');
    expect(hasClip(b.chainKeys, 'sub-b')).toBe(true);
    expect(hasClip(b.chainKeys, 'sub-a')).toBe(false);
    b.expectPixelAt(32, 32, { r: 0, g: 255, b: 0 }, 2);
  });

  it('an interior sub-clip is a layer like any other', async () => {
    // A sequence clip contributes exactly ONE composited layer — its own — not
    // one per interior clip. (`layerCount` counts `_blend` keys on both sides.)
    const run = await runCompScenario({
      doc: sequenceDoc(),
      ops: [{ seek: IN_A }, { capture: 'a' }],
    });
    expect(run.capture('a').layerCount).toBe(1);
  });

  it('outside the sequence clip nothing of the interior survives', async () => {
    // The interior is scoped to its owner's span: past it, neither sub-clip may
    // linger in the chain (a leaked interior renders content that is no longer
    // anywhere on the timeline).
    const run = await runCompScenario({
      doc: sequenceDoc(),
      ops: [{ seek: 60 }, { capture: 'after' }],
    });
    const after = run.capture('after');
    expect(hasClip(after.chainKeys, 'sub-a')).toBe(false);
    expect(hasClip(after.chainKeys, 'sub-b')).toBe(false);
    expect(after.hasContent).toBe(false);
  });

  it('marks exactly one interior video sub-clip live and PRIMES its sibling', async () => {
    // Every interior desc ships the sequence clip's window (unbounded — the
    // interior can loop), so the pump cannot tell live from warm by window
    // alone: it keys off `prime`. Before that fix all N interior clips read as
    // actively playing, ran full-rate decoders against one service, and
    // whichever lost the race blanked.
    //
    // This asserts the DESC SET, which the comp executor publishes; the case
    // below asserts the decode.
    const run = await runCompScenario({
      doc: videoSequenceDoc(),
      ops: [{ seek: 1 }, SETTLE, { capture: 'live-a' },
            { seek: 5 }, SETTLE, { capture: 'live-b' }],
    });

    const a = run.capture('live-a');
    expect(a.descFor('sub-a')).not.toBeNull();
    expect(!!a.descFor('sub-a')!.prime).toBe(false);     // A is the one playing
    expect(a.descFor('sub-b')).not.toBeNull();           // B is present...
    expect(!!a.descFor('sub-b')!.prime).toBe(true);      // ...but only pre-rolled

    // Across the interior switch the roles swap exactly. A is BEHIND the
    // interior clock and this sequence spans exactly its interior extent, so it
    // does not loop and A is never upcoming again — dropping out of the desc set
    // entirely is correct, its decoder released rather than left spinning.
    const b = run.capture('live-b');
    expect(b.descFor('sub-b')).not.toBeNull();
    expect(!!b.descFor('sub-b')!.prime).toBe(false);
    expect(b.descFor('sub-a')).toBeNull();
  });

  it('decodes interior video through the times channel, each sub-clip in turn', async () => {
    // An interior sub-clip is TRANSPORT-DRIVEN: its source time comes from a
    // synthetic transport row (arrangement beat → sequence content sec →
    // interior beat → source sec) that the pre-pass publishes, not from its
    // ClipLoopConfig. Both pumps read the last frame's rows — the app's own
    // one-frame lag. Until M2 both runners skipped these by name, which left
    // every sequence interior transparent in the native engine.
    const run = await runCompScenario({
      doc: videoSequenceDoc(),
      width: 64,
      height: 64,
      ops: [{ seek: 1 }, SETTLE, { capture: 'live-a' },
            { play: { frames: 30, dtSec: 1 / 60 } }, { capture: 'a-later' },
            { seek: 5 }, SETTLE, { capture: 'live-b' }],
    });

    run.expectNothingSkipped();
    const a = run.capture('live-a');
    expect(a.hasContent).toBe(true);
    expect(a.meanLuma()).toBeGreaterThan(4);
    expect(a.lumaSpread()).toBeGreaterThan(8);
    // Playing, not pinned on an entry frame: half a second later a different
    // source frame is on screen.
    expect(run.capture('a-later').diffBytes(a)).toBeGreaterThan(a.pixels.length / 50);

    const b = run.capture('live-b');
    expect(b.lumaSpread()).toBeGreaterThan(8);
    expect(run.videoClips['sub-b']?.injects ?? 0).toBeGreaterThan(0);
  });
});
});
