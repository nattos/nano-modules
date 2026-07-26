/**
 * Dual-backend e2e: a SOURCE clip with transparency composites OVER the track
 * below it, instead of baking its transparent regions to opaque black.
 *
 * Layout (tracks composite DOWNWARD, so the lower track draws on top):
 *   t-back = noise                     — the backdrop that must show through
 *   t-crop = noise → warp.crop(0.45)   — opaque in the middle 10%, transparent
 *                                        everywhere else
 *
 * The regression this pins is in `composite.blend`'s source-over path: it used
 * to force the layer opaque, so outside the crop the composite was flat black
 * rather than the backdrop. That is invisible in the middle of the frame — only
 * a REGION measure catches it, which is why every assertion here samples one
 * quadrant rather than the whole frame.
 *
 * Note what is NOT asserted: alpha. The composite's own output is always opaque
 * (`arr_bg` backs the stack), so a transparent region reads as the stage's
 * black, not as alpha 0 — measured on both backends. Transparency is therefore
 * only observable as what shows THROUGH, which is what these three cases pin:
 * revealed / nothing to reveal / hidden by an opaque layer.
 *
 *   npx jest arrangement-transparency-parity
 */

import { forEachBackend, runCompScenario } from './comp-test-helpers';
import { croppedOverlayDoc, mkClip, mkComposition, mkDevice, mkTrack } from './fixtures/comp-docs';

/** Both clips live at [40, 48) — a clear stretch, well past beat 0. */
const AT_CLIPS = 44;

/** The top-left quadrant: entirely outside a 0.45-inset centre crop. */
const CORNER = [0, 0, 0.25, 0.25] as const;

forEachBackend((backend) => {
describe(`Source-clip transparency, dual-backend (${backend})`, () => {
  jest.setTimeout(180_000);

  it('a cropped source clip reveals the track below outside its crop', async () => {
    const run = await runCompScenario({
      doc: croppedOverlayDoc(),
      ops: [{ seek: AT_CLIPS }, { capture: 'over' }],
    });
    const over = run.capture('over');

    expect(over.hasContent).toBe(true);
    expect(over.layerCount).toBe(2);

    // The corner is outside the crop, so what it shows is the backdrop's noise
    // — spatially varied. Baked-to-opaque-black reads a spread of ~0.
    expect(over.regionLumaSpread(...CORNER)).toBeGreaterThan(4);
    // The crop's own content still renders in the middle.
    expect(over.regionLumaSpread(0.45, 0.45, 0.55, 0.55)).toBeGreaterThan(4);
  });

  it('with nothing below it, the same region is flat black', async () => {
    // The control that makes the case above mean something: bypass the backdrop
    // and the corner must go BLACK. Without this a crop that leaked its own
    // noise everywhere would pass the reveal assertion just as well.
    const run = await runCompScenario({
      doc: croppedOverlayDoc(),
      ops: [{ seek: AT_CLIPS }, { bypass: { id: 't-back', on: true } }, { capture: 'alone' }],
    });
    const alone = run.capture('alone');

    expect(alone.hasContent).toBe(true);
    expect(alone.layerCount).toBe(1);
    expect(alone.regionLumaSpread(...CORNER)).toBeLessThan(2);
    const corner = alone.pixelAt(4, 4);
    expect(corner.r + corner.g + corner.b).toBeLessThan(8);
    // ...while the crop itself is untouched: the centre still carries content.
    expect(alone.regionLumaSpread(0.45, 0.45, 0.55, 0.55)).toBeGreaterThan(4);
  });

  it('an OPAQUE layer hides the track below it entirely', async () => {
    // The other direction: source-over must still be over. A solid clip with no
    // crop covers the frame, so the backdrop's noise contributes nothing —
    // a blend that composited the wrong way round would leak it back in.
    const run = await runCompScenario({
      doc: mkComposition([
        mkTrack('t-back', [mkClip('c-back', 40, 8, [mkDevice('d-back', 'source.noise')])]),
        mkTrack('t-cover', [mkClip('c-cover', 40, 8, [
          mkDevice('d-cover', 'source.solid_color', { color: [0.2, 0.4, 0.8] }),
        ])]),
      ]),
      ops: [{ seek: AT_CLIPS }, { capture: 'cover' }],
    });
    const cover = run.capture('cover');

    expect(cover.layerCount).toBe(2);
    expect(cover.regionLumaSpread(...CORNER)).toBeLessThan(2);
    cover.expectPixelAt(4, 4, { r: 51, g: 102, b: 204 }, 4);
  });
});
});
