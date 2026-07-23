import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for source.sdf.plume (nano bundle) — the SDF volume renderer
 * flagship (milestone 1: shell map -> SDF bake -> sphere-trace -> shade).
 *
 * Determinism: `orbit: 0` and `morph: 0` stop both accumulators at phase 0
 * (rate 0 at slider 0), so static A/B comparisons are pixel-stable. The
 * default camera frames the displaced sphere well inside the 96² probe
 * frame: center (48,48) is always ON the body, corner (3,3) is always
 * background. Engine traces are checkerboard-composited (alpha always
 * 255) — assert by color.
 */

const BG = { r: 178, g: 178, b: 191 };
const lum = (c: { r: number, g: number, b: number }) => (c.r + c.g + c.b) / 3;

// Frozen accumulators + dark body against the bright input.
const STATIC = {
  orbit: 0.0, morph: 0.0, tilt: 0.1, zoom: 0.25,
  albedo: [0.1, 0.1, 0.1], opacity: 1.0,
};

function buildSketch(params: Record<string, unknown>,
                     opts?: { noInput?: boolean }): Sketch {
  const chain: any[] = [];
  if (!opts?.noInput) {
    chain.push({ type: 'module', module_type: 'source.solid_color',
                 instance_key: 'bg@0', params: { color: [0.7, 0.7, 0.75] } });
  }
  chain.push({ type: 'module', module_type: 'source.sdf.plume',
               instance_key: 'plume@0', params });
  return { anchor: null, chain, wires: [] } as Sketch;
}

async function render(sketchId: string, params: Record<string, unknown>,
                      opts?: { noInput?: boolean, waitFrames?: number }) {
  const result = await runEngineTest({
    width: 96, height: 96,
    modules: ['com.nano.core', 'com.nano.nano'],
    commands: [
      { type: 'createSketch', sketchId, sketch: buildSketch(params, opts) },
      { type: 'setTracePoints', tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId } },
      ]},
    ],
    waitFrames: opts?.waitFrames ?? 4,
    captureTraceIds: ['out'],
    dumpName: sketchId,
  });
  expect(result.success).toBe(true);
  return result;
}

describe('source.sdf.plume E2E', () => {
  jest.setTimeout(120000);

  it('dark displaced sphere reads against a bright input', async () => {
    const r = await render('plume_smoke', { ...STATIC });
    // Body center clearly darker than the input; corners untouched.
    const center = r.trace('out').pixelAt(48, 48);
    expect(lum(center)).toBeLessThan(lum(BG) - 40);
    r.trace('out').expectPixelAt(3, 3, BG, 8);
    r.trace('out').expectPixelAt(92, 92, BG, 8);
    const plugin = r.state.plugins.find((p: any) => p.id === 'source.sdf.plume');
    expect(plugin).toBeTruthy();
  });

  it('runs as a pure generator with no input wired', async () => {
    const r = await render('plume_gen',
      { ...STATIC, albedo: [0.8, 0.8, 0.85], sun: 0.8 }, { noInput: true });
    // The lit body must produce real pixels at center.
    const center = r.trace('out').pixelAt(48, 48);
    expect(lum(center)).toBeGreaterThan(30);
    r.trace('out').expectNotSolidColor(center, 5);
  });

  it('opacity 0 is a bit-exact passthrough', async () => {
    const r = await render('plume_passthrough', { ...STATIC, opacity: 0 });
    for (const [x, y] of [[48, 48], [30, 30], [66, 66], [48, 20], [3, 3]]) {
      r.trace('out').expectPixelAt(x, y, BG, 4);
    }
  });

  it('ridge depth changes the surface', async () => {
    const smooth = await render('plume_depth0', { ...STATIC, ridge_depth: 0.0 });
    const ridged = await render('plume_depth1', { ...STATIC, ridge_depth: 1.0 });
    ridged.trace('out').expectDifferentFrom(smooth.trace('out'), 10);
  });

  it('ridge scale changes the flake frequency', async () => {
    const coarse = await render('plume_scale_lo',
      { ...STATIC, ridge_depth: 0.8, ridge_scale: 0.2 });
    const fine = await render('plume_scale_hi',
      { ...STATIC, ridge_depth: 0.8, ridge_scale: 0.9 });
    fine.trace('out').expectDifferentFrom(coarse.trace('out'), 8);
  });

  it('sun azimuth moves the shading', async () => {
    const base = { ...STATIC, albedo: [0.5, 0.5, 0.5] };
    const left = await render('plume_sun_l', { ...base, azimuth: -70 });
    const right = await render('plume_sun_r', { ...base, azimuth: 70 });
    left.trace('out').expectDifferentFrom(right.trace('out'), 8);
  });

  it('debug views render the internal state', async () => {
    // SDF slice through the volume center: inside/outside + surface band
    // structure, nothing like the normal render.
    const slice = await render('plume_dbg_sdf',
      { ...STATIC, debug_view: 1, debug_slice: 0.5 });
    slice.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    const normal = await render('plume_dbg_off', { ...STATIC });
    slice.trace('out').expectDifferentFrom(normal.trace('out'), 30);
    // Shell map view renders the octahedral field.
    const shell = await render('plume_dbg_shell',
      { ...STATIC, debug_view: 2, ridge_depth: 0.8 });
    shell.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    shell.trace('out').expectDifferentFrom(slice.trace('out'), 20);
  });

  it('orbit animates across frames', async () => {
    const moving = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nano.core', 'com.nano.nano'],
      dumpName: 'plume_anim',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'plume_anim',
              sketch: buildSketch({ ...STATIC, ridge_depth: 0.9, orbit: 0.9,
                                    albedo: [0.5, 0.5, 0.5] }) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'plume_anim' } },
            ]},
          ],
          waitFrames: 3, captureTraceIds: ['out'],
        },
        { waitFrames: 30, captureTraceIds: ['out'] },
      ],
    });
    expect(moving.success).toBe(true);
    moving.phases[1].trace('out').expectDifferentFrom(moving.phases[0].trace('out'), 10);
  });
});
