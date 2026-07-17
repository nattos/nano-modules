import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for source.mesh.monolith (nano bundle) — the glassy 3D
 * primitive generator (1:4:9 monolith slab / regular triangular pyramid, up
 * to 3 concentric shells, exact analytic painter's order, alpha over input).
 *
 * Determinism trick: `motion: Arc` with `arc: 0` pins the pose to a slow
 * eased sweep start (yaw ≈ -20°, drift far below a pixel over test spans),
 * so static comparisons are rAF-jitter-proof. Animation is asserted
 * structurally (phases differ), never pixel-exact — headless frame pacing
 * varies 4–20 ms.
 *
 * Probe rig: solid dark-blue input → monolith. bg (0.05, 0.05, 0.25) reads as
 * ~(13, 13, 64); the near-white default shape reads far brighter. Note engine
 * traces are checkerboard-composited (alpha always 255) — assert by color.
 */

const BG = { r: 13, g: 13, b: 64 };

// Static pose: zero arc width (yaw pinned ≈ -20°) + a slight signed tilt so
// several faces show.
const STATIC = { motion: 0 /* Arc */, arc: 0.0, tilt: 0.2, alpha: 1.0, size: 0.8 };

function buildSketch(params: Record<string, unknown>): Sketch {
  return {
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'bg@0',
        params: { color: [0.05, 0.05, 0.25] } },
      { type: 'module', module_type: 'source.mesh.monolith', instance_key: 'mono@0',
        params },
    ],
  } as Sketch;
}

async function render(sketchId: string, params: Record<string, unknown>,
                      waitFrames = 4) {
  const result = await runEngineTest({
    width: 96, height: 96,
    modules: ['com.nano.testonly', 'com.nano.nano'],
    commands: [
      { type: 'createSketch', sketchId, sketch: buildSketch(params) },
      { type: 'setTracePoints', tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId } },
      ]},
    ],
    waitFrames,
    captureTraceIds: ['out'],
    dumpName: sketchId,
  });
  expect(result.success).toBe(true);
  return result;
}

describe('source.mesh.monolith E2E', () => {
  jest.setTimeout(90000);

  it('registers and renders the slab over the input', async () => {
    const r = await render('mono_smoke', { ...STATIC });
    r.trace('out').expectNotSolidColor(BG, 5);
    const plugin = r.state.plugins.find((p: any) => p.id === 'source.mesh.monolith');
    expect(plugin).toBeTruthy();
  });

  it('composites: bright shape at center, untouched input at the corners', async () => {
    const r = await render('mono_composite', { ...STATIC });
    // At size 0.8 the slab spans roughly x∈[35,61], y∈[19,77] on the 96×96
    // frame — the center is deep inside it, the corners far outside.
    const center = r.trace('out').pixelAt(48, 48);
    expect(center.r).toBeGreaterThan(120);   // near-white shaded face
    expect(center.b).toBeGreaterThan(120);
    r.trace('out').expectPixelAt(3, 3, BG, 8);
    r.trace('out').expectPixelAt(92, 92, BG, 8);
  });

  it('alpha 0 is a pure passthrough (draw pass skipped)', async () => {
    const r = await render('mono_alpha0', { ...STATIC, alpha: 0.0 });
    for (const [x, y] of [[48, 48], [30, 30], [66, 66], [48, 20], [3, 3]]) {
      r.trace('out').expectPixelAt(x, y, BG, 4);
    }
  });

  it('tumble animates across frames', async () => {
    const moving = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nano.testonly', 'com.nano.nano'],
      dumpName: 'mono_anim',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'mono_anim',
              sketch: buildSketch({ motion: 1 /* Tumble */, speed: 0.9,
                                    alpha: 1.0, size: 0.8, tilt: 0.2 }) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'mono_anim' } },
            ]},
          ],
          waitFrames: 3, captureTraceIds: ['out'],
        },
        { waitFrames: 30, captureTraceIds: ['out'] },
      ],
    });
    expect(moving.success).toBe(true);
    moving.phases[1].trace('out').expectDifferentFrom(moving.phases[0].trace('out'), 20);
  });

  it('concentric copies add shells around the core', async () => {
    const one = await render('mono_copies1', { ...STATIC, alpha: 0.7, copies: 1 });
    const three = await render('mono_copies3',
      { ...STATIC, alpha: 0.7, copies: 3, spread: 1.0, falloff: 0.2 });
    three.trace('out').expectDifferentFrom(one.trace('out'), 15);
  });

  it('pyramid and monolith silhouettes differ', async () => {
    const slab = await render('mono_shape_slab', { ...STATIC, shape: 0 });
    const pyramid = await render('mono_shape_pyramid', { ...STATIC, shape: 1 });
    pyramid.trace('out').expectNotSolidColor(BG, 5);
    pyramid.trace('out').expectDifferentFrom(slab.trace('out'), 20);
  });

  it('opaque solids never leak back faces (analytic draw order)', async () => {
    // The old centroid depth sort let a far-face triangle of the rotated
    // thin slab draw on top of the near face (a dark wedge on the front).
    // With the exact onion order and alpha 1, back faces are fully occluded:
    // cranking back_dim must change NOTHING on screen.
    const dim = await render('mono_opaque_dim', { ...STATIC, back_dim: 1.0 });
    const undim = await render('mono_opaque_undim', { ...STATIC, back_dim: 0.0 });
    dim.trace('out').expectSameAs(undim.trace('out'), 2);
  });

  it('glassy: back-face dimming shows through a semi-transparent shape', async () => {
    // At alpha 0.5 the far faces are visible through the near ones, so the
    // back-face dim level must change on-screen pixels.
    const dimmed = await render('mono_glass_dim', { ...STATIC, alpha: 0.5, back_dim: 1.0 });
    const undimmed = await render('mono_glass_undim', { ...STATIC, alpha: 0.5, back_dim: 0.0 });
    dimmed.trace('out').expectDifferentFrom(undimmed.trace('out'), 10);
  });
});
