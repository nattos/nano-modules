import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';
import { Frame } from './gpu-test-helpers';

/**
 * source.text.plain Bold/Italic E2E (web engine + text_engine.wasm).
 *
 * Bold/Italic must take visible effect for EVERY font configuration — the
 * engine synthesizes faux bold (outline embolden, which also widens advances)
 * and faux oblique (shear) whenever the resolved face isn't truly styled. That
 * covers the primary font (blank Font), the bundled regular-only families
 * (e.g. Noto Sans), and web sessions where Local Font Access hasn't resolved a
 * named OS family yet. Previously these params were silently dead: the effect
 * only emitted weight/italic when a Font was named, and a missing styled face
 * fell back to the regular face with no synthesis.
 *
 * Ink metrics: lit-pixel width (bold widens — embolden grows each advance) and
 * slant (mean lit-x of the ink's top third minus its bottom third — oblique
 * leans glyph tops rightward; both renders draw the same string, so glyph-mix
 * asymmetry cancels).
 */
describe('source.text.plain bold/italic synthesis E2E', () => {
  jest.setTimeout(60000);

  const build = (params: Record<string, unknown>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.text.plain', instance_key: 't@0',
        params: { text: 'Hamburgefonstiv', size: 48, ...params } },
    ],
    wires: [],
  } as unknown as Sketch);

  const run = (id: string, params: Record<string, unknown>) => runEngineTest({
    width: 512, height: 128,
    modules: ['com.nano.text'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(params) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  // The traced frame composites transparency over a checkerboard (gray
  // 140/191, alpha 255), so ink = near-white pixels, not alpha.
  const isInk = (f: Frame, x: number, y: number) =>
    f.pixels[(y * f.width + x) * 4] > 220;

  const inkStats = (f: Frame): { width: number; slant: number } => {
    let loX = f.width, hiX = -1, loY = f.height, hiY = -1;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++)
        if (isInk(f, x, y)) {
          if (x < loX) loX = x;
          if (x > hiX) hiX = x;
          if (y < loY) loY = y;
          if (y > hiY) hiY = y;
        }
    let xTop = 0, xBot = 0, nTop = 0, nBot = 0;
    const third = Math.floor((hiY - loY + 1) / 3);
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        if (!isInk(f, x, y)) continue;
        if (y < loY + third) { xTop += x; nTop++; }
        if (y > hiY - third) { xBot += x; nBot++; }
      }
    return { width: hiX - loX,
             slant: nTop && nBot ? xTop / nTop - xBot / nBot : 0 };
  };

  it('bold/italic act on the primary font (blank Font)', async () => {
    const reg = await run('txt_reg', {});
    const bold = await run('txt_bold', { bold: 1 });
    const ital = await run('txt_ital', { italic: 1 });
    expect(reg.success && bold.success && ital.success).toBe(true);

    const r = inkStats(reg.trace('out'));
    const b = inkStats(bold.trace('out'));
    const i = inkStats(ital.trace('out'));
    // Sanity: real text rendered at a plausible size.
    expect(r.width).toBeGreaterThan(100);
    // Faux bold widens the line (embolden also widens advances).
    expect(b.width).toBeGreaterThan(r.width + 5);
    // Faux oblique leans the ink's top rightward.
    expect(i.slant).toBeGreaterThan(r.slant + 2);
  });

  it('bold acts on a bundled regular-only family (Noto Sans)', async () => {
    const reg = await run('txt_noto', { font: 'Noto Sans' });
    const bold = await run('txt_noto_bold', { font: 'Noto Sans', bold: 1 });
    expect(reg.success && bold.success).toBe(true);
    const r = inkStats(reg.trace('out'));
    const b = inkStats(bold.trace('out'));
    expect(r.width).toBeGreaterThan(100);
    expect(b.width).toBeGreaterThan(r.width + 5);
  });
});
