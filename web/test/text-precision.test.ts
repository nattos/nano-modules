import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';
import { Frame } from './gpu-test-helpers';

/**
 * Edges (Precision) E2E for both text effects — the WebGPU half of the analytic
 * outline path.
 *
 * MSDF is a fixed-resolution field: well above the atlas reference em it rounds
 * corners and can punch pinholes through thin strokes. `precision` = Precise
 * evaluates the real outline per pixel in the fragment shader instead; Auto
 * fades between the two per glyph as it grows.
 *
 * The engine-side math is pinned natively (test_text_precise.cpp) and proven
 * byte-identical native↔wasm (parity_check.sh). What can ONLY be verified here
 * is that the WGSL twin compiles, receives the outline storage buffer at binding
 * 4, and produces the same picture — so these tests check the properties that
 * would break if the shader path were wrong: Precise differs from Smooth at
 * large sizes, its interiors are solid, and Auto is byte-identical to Smooth
 * below the fade (i.e. the new branch is genuinely inert there).
 */
describe('text precision (Edges) E2E', () => {
  jest.setTimeout(120000);

  const SMOOTH = 1, PRECISE = 2, AUTO = 0;

  const build = (params: Record<string, unknown>): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.text.plain', instance_key: 't@0',
        params: { text: 'O', size: 460, v_align: 0, v_pos: 0.5, ...params } },
    ],
    wires: [],
  } as unknown as Sketch);

  const run = (id: string, params: Record<string, unknown>) => runEngineTest({
    width: 640, height: 640,
    modules: ['com.nano.text'],
    commands: [{ type: 'createSketch', sketchId: id, sketch: build(params) }],
    tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
    captureTraceIds: ['out'],
    waitFrames: 20,
    dumpName: id,
  });

  // The traced frame composites transparency over a checkerboard (gray
  // 140/191, alpha 255), so ink = near-white pixels, not alpha.
  const lum = (f: Frame, x: number, y: number) => f.pixels[(y * f.width + x) * 4];
  const isInk = (f: Frame, x: number, y: number) => lum(f, x, y) > 220;

  const inkCount = (f: Frame): number => {
    let n = 0;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) if (isInk(f, x, y)) n++;
    return n;
  };

  const differingPixels = (a: Frame, b: Frame): number => {
    let n = 0;
    for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i] !== b.pixels[i]) n++;
    return n;
  };

  // A pixel is INTERIOR when everything within radius 3 is also inked — that
  // excludes the antialiased rind, including the near-horizontal top and bottom
  // of a round glyph where a whole row is edge.
  const holeCount = (f: Frame): { holes: number; interior: number } => {
    const R = 3;
    let holes = 0, interior = 0;
    for (let y = R; y < f.height - R; y++) {
      for (let x = R; x < f.width - R; x++) {
        if (!isInk(f, x, y)) continue;
        let solid = true;
        for (let j = -R; j <= R && solid; j++)
          for (let i = -R; i <= R; i++)
            if (i * i + j * j <= R * R && !isInk(f, x + i, y + j)) { solid = false; break; }
        if (!solid) continue;
        interior++;
        if (lum(f, x, y) < 255) holes++;
      }
    }
    return { holes, interior };
  };

  it('precise differs from smooth at a large size, and fills solid', async () => {
    const smooth = await run('prec_smooth', { precision: SMOOTH });
    const precise = await run('prec_precise', { precision: PRECISE });
    expect(smooth.success && precise.success).toBe(true);

    const s = smooth.trace('out'), p = precise.trace('out');
    // Sanity: a big glyph really rendered.
    expect(inkCount(p)).toBeGreaterThan(20000);

    // The analytic branch actually ran in the shader — if the outline buffer
    // or the blend weight never reached the fragment, these would be identical.
    const diff = differingPixels(s, p);
    expect(diff).toBeGreaterThan(200);
    // ...but it is a refinement of the same glyph, not a different picture.
    expect(diff).toBeLessThan(inkCount(p) * 0.5);

    // The headline artifact: no interior pixel may be less than fully covered.
    const h = holeCount(p);
    expect(h.interior).toBeGreaterThan(5000);
    expect(h.holes).toBe(0);
  });

  it('auto is inert below the fade', async () => {
    // The fade starts at 3x the Latin reference em (64) = 192 device px; 120
    // sits well below it, so Auto must take exactly the MSDF path.
    const auto = await run('prec_auto_small', { size: 120, precision: AUTO });
    const smooth = await run('prec_smooth_small', { size: 120, precision: SMOOTH });
    expect(auto.success && smooth.success).toBe(true);
    const a = auto.trace('out'), s = smooth.trace('out');
    expect(inkCount(a)).toBeGreaterThan(2000);
    expect(differingPixels(a, s)).toBe(0);
  });

  it('rich text carries the same setting through the Blitz path', async () => {
    // source.text.rich reaches the engine by a different route — Blitz shapes the
    // runs and they enter through layoutGlyphs, not the attributed-string spec —
    // so its `precision` plumbing needs its own proof.
    const html = '<div style="font-size:460px;line-height:1;color:#fff">O</div>';
    const richRun = (id: string, precision: number) => runEngineTest({
      width: 640, height: 640,
      modules: ['com.nano.richtext'],
      commands: [{ type: 'createSketch', sketchId: id, sketch: {
        anchor: null,
        chain: [{ type: 'module', module_type: 'source.text.rich', instance_key: 'r@0',
                  params: { html, css: '', precision } }],
        wires: [],
      } as unknown as Sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: id,
    });

    const smooth = await richRun('rich_smooth', SMOOTH);
    const precise = await richRun('rich_precise', PRECISE);
    expect(smooth.success && precise.success).toBe(true);
    const s = smooth.trace('out'), p = precise.trace('out');
    expect(inkCount(p)).toBeGreaterThan(20000);
    expect(differingPixels(s, p)).toBeGreaterThan(200);
    expect(holeCount(p).holes).toBe(0);
  });

  it('auto reaches the precise path at a large size', async () => {
    const auto = await run('prec_auto_big', { precision: AUTO });
    const precise = await run('prec_precise_big', { precision: PRECISE });
    const smooth = await run('prec_smooth_big', { precision: SMOOTH });
    expect(auto.success && precise.success && smooth.success).toBe(true);
    const a = auto.trace('out'), p = precise.trace('out'), s = smooth.trace('out');
    // 460 px is past the end of the fade (192 -> 384), so Auto IS Precise.
    expect(differingPixels(a, p)).toBe(0);
    expect(differingPixels(a, s)).toBeGreaterThan(200);
  });
});
