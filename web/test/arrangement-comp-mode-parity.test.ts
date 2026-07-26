/**
 * DUAL-BACKEND e2e for the composition executor: the same scenarios run against
 * `executor.wasm` in the browser and against `comp::CompExecutor` natively on
 * Metal, from one test body (`forEachBackend`).
 *
 * These are the portable half of `arrangement-comp-mode.test.ts` — everything
 * that exercises the ENGINE rather than the app shell. The cases that stay in
 * that file need the live store, the DOM monitor, or the video decode pump,
 * none of which exist natively yet.
 *
 * Time is FIXED-STEP here (`play: { frames, dtSec }`), never rAF-paced, which
 * is what makes the two backends comparable at all — see
 * `project_e2e_raf_pacing_variable`.
 *
 *   # both backends (native half needs the CLI built):
 *   cmake --build native/build --target comp_test_runner
 *   GPU_TEST_BASE_URL=http://localhost:5173 npx jest arrangement-comp-mode-parity
 */

import {
  forEachBackend,
  runCompScenario,
  ensureCompRunnerPage,
  type CompOp,
} from './comp-test-helpers';
import {
  layeredCompositeDoc,
  railReadWireDoc,
  layerOpacityRailDoc,
  mkComposition,
  mkTrack,
  mkClip,
  mkDevice,
} from './fixtures/comp-docs';

const STEP = 1 / 60;

/** `n` captures, each after `framesEach` fixed steps — a sampled sweep. */
function sweep(n: number, framesEach: number, prefix = 's'): CompOp[] {
  const ops: CompOp[] = [];
  for (let i = 0; i < n; i++) {
    ops.push({ play: { frames: framesEach, dtSec: STEP } });
    // Zero-padded so `captures(prefix)` comes back in scenario order.
    ops.push({ capture: `${prefix}${String(i).padStart(2, '0')}` });
  }
  return ops;
}

forEachBackend((backend) => {
  describe(`Composition executor parity (${backend})`, () => {
    jest.setTimeout(180_000);

    beforeAll(async () => {
      // Boot the browser runner once for the whole file; the native CLI is
      // spawned per scenario and needs no warm-up.
      if (backend === 'puppeteer') await ensureCompRunnerPage();
    });

    it('renders a layered composite (blend + opacity + adjustment) with stable pixels', async () => {
      const run = await runCompScenario({
        doc: layeredCompositeDoc(),
        width: 64,
        height: 64,
        ops: [
          { seek: 42 },
          { capture: 'a' },
          // Nothing in this document is time-dependent, so a second capture a
          // full second later must be the SAME frame, byte for byte.
          { play: { frames: 60, dtSec: STEP } },
          { capture: 'b' },
        ],
      });

      const a = run.capture('a');
      expect(a.hasContent).toBe(true);
      // Two BLENDED layers (the two solids). The effect-only invert clip is not
      // a layer — it processes the composite in place, so it contributes a
      // chain entry but no `_blend`.
      a.expectLayerCount(2);
      // A real composite, not a black or blown-out frame.
      expect(a.meanLuma()).toBeGreaterThan(10);
      expect(a.meanLuma()).toBeLessThan(245);

      const b = run.capture('b');
      expect(b.diffBytes(a)).toBe(0);
      expect(b.positionBeat).toBeCloseTo(a.positionBeat + 2, 6); // 1s @120BPM
    });

    it('bypassing a track structurally drops its layer, un-bypassing restores it', async () => {
      const run = await runCompScenario({
        doc: layeredCompositeDoc(),
        width: 64,
        height: 64,
        ops: [
          { seek: 42 },
          { capture: 'all' },
          { bypass: { id: 't-mid', on: true } },
          { capture: 'dropped' },
          { bypass: { id: 't-mid', on: false } },
          { capture: 'restored' },
        ],
      });

      run.capture('all').expectLayerCount(2);
      run.capture('dropped').expectLayerCount(1);
      run.capture('restored').expectLayerCount(2);
      // Dropping a layer must actually change the picture, and restoring it
      // must return EXACTLY the original frame.
      expect(run.capture('dropped').diffBytes(run.capture('all'))).toBeGreaterThan(0);
      expect(run.capture('restored').diffBytes(run.capture('all'))).toBe(0);
    });

    it('param cheap ops re-render without a document reload', async () => {
      const run = await runCompScenario({
        doc: mkComposition([
          mkTrack('t-1', [mkClip('c-1', 0, 16, [
            mkDevice('d-1', 'source.solid_color', { color: [0.25, 0.25, 0.25] }),
          ])]),
        ]),
        width: 32,
        height: 32,
        ops: [
          { seek: 1 },
          { capture: 'dim' },
          { setParam: { ownerId: 'c-1', deviceId: 'd-1', field: 'color', value: [1, 1, 1] } },
          { capture: 'bright' },
        ],
      });

      const dim = run.capture('dim');
      const bright = run.capture('bright');
      expect(bright.meanLuma()).toBeGreaterThan(dim.meanLuma() + 40);
      // The chain is untouched by a param edit — same layer set, same keys.
      expect(bright.chainKeys).toEqual(dim.chainKeys);
    });

    it('track level scales its layer into the composite', async () => {
      const run = await runCompScenario({
        doc: mkComposition([
          mkTrack('t-1', [mkClip('c-1', 0, 16, [
            mkDevice('d-1', 'source.solid_color', { color: [1, 1, 1] }),
          ])]),
        ]),
        width: 32,
        height: 32,
        ops: [
          { seek: 1 },
          { capture: 'full' },
          { trackLevel: { trackId: 't-1', level: 0.25 } },
          { capture: 'quarter' },
        ],
      });

      expect(run.capture('quarter').meanLuma())
        .toBeLessThan(run.capture('full').meanLuma());
    });

    it('the transport advances at exactly the stepped rate', async () => {
      const run = await runCompScenario({
        doc: layeredCompositeDoc(),
        width: 32,
        height: 32,
        ops: [
          { seek: 40 },
          { capture: 'start' },
          { play: { frames: 30, dtSec: STEP } },   // 0.5 s
          { capture: 'half' },
          { play: { frames: 30, dtSec: STEP } },   // 1.0 s total
          { capture: 'one' },
        ],
      });

      // 120 BPM ⇒ 2 beats/second. Fixed-step, so this is exact, not approximate.
      expect(run.capture('start').positionBeat).toBeCloseTo(40, 6);
      expect(run.capture('half').positionBeat).toBeCloseTo(41, 6);
      expect(run.capture('one').positionBeat).toBeCloseTo(42, 6);
    });

    it('rails: a return-track read wire modulates its target (writer beats base re-assert)', async () => {
      // The regression this pins: the arrangement re-asserts each rail's BASE
      // via per-frame automation (combine replace), and the executor applied
      // that AFTER the wire fold on the same field — clobbering the writer every
      // frame. Rails sat pinned at base and read wires never moved their
      // targets, so the frame was CONSTANT. A spread of exactly 0 is the dead
      // signal; see project_comp_wire_freeze_structural_change.
      const run = await runCompScenario({
        doc: railReadWireDoc(),
        width: 32,
        height: 32,
        // LFO at 1 Hz (see LFO_1HZ); 10 samples × 6 frames = 1 s = one full
        // period, so the sweep can't alias to a constant.
        ops: [{ seek: 0 }, ...sweep(10, 6)],
      });

      const lumas = run.captures('s').map((c) => c.centerLuma());
      expect(lumas.length).toBe(10);
      const spread = Math.max(...lumas) - Math.min(...lumas);
      expect(spread).toBeGreaterThan(60);
    });

    it('layer opacity: a track-level rail read sweeps the layer in/out', async () => {
      const run = await runCompScenario({
        doc: layerOpacityRailDoc(),
        width: 32,
        height: 32,
        ops: [{ seek: 0 }, ...sweep(10, 6)],
      });

      const lumas = run.captures('s').map((c) => c.meanLuma());
      expect(lumas.length).toBe(10);
      const spread = Math.max(...lumas) - Math.min(...lumas);
      expect(spread).toBeGreaterThan(30);
    });

    it('an empty beat renders no content', async () => {
      const run = await runCompScenario({
        doc: layeredCompositeDoc(),  // clips span beats 40..48
        width: 32,
        height: 32,
        ops: [{ seek: 4 }, { capture: 'gap' }, { seek: 42 }, { capture: 'onclip' }],
      });

      expect(run.capture('gap').hasContent).toBe(false);
      expect(run.capture('onclip').hasContent).toBe(true);
    });
  });
});
