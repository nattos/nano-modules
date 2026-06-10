import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for video.shape_fold (nano bundle) — the evolving-shape
 * generator. A baked atlas is resolved on the CPU to a few terms; the GPU
 * evaluates the SDF field and auto-levels it every frame (minmax → hist →
 * buildlut → present). This is the first real exercise of the WebGPU
 * translation of the atomic storage-buffer auto-levels passes.
 *
 * Under test:
 *  1. Registers + renders: a busy cell produces a non-solid auto-leveled field
 *     (the four-pass pipeline dispatches cleanly on WebGPU).
 *  2. output_mode: Grayscale vs Magma differ (same field, different encoding).
 *  3. scale (domain zoom) changes the output — the periodic field reveals more
 *     structure when zoomed out.
 *  4. autopilot is a live, non-destructive override: with the time clock frozen
 *     (time_speed=0) the output STILL animates across frames when autopilot is
 *     on (the epicycle moves the effective XY) and is STATIC when it's off —
 *     all without ever patching the frequency/simplicity inputs.
 *  5. Broadcast wiring: autopilot_x / autopilot_y are declared as data_output
 *     fields (kind=2) — the channel the custom XY-pad editor reads live.
 *
 * The generator ignores its input, so the chain is just
 * texture_input → shape_fold → texture_output.
 */
function buildSketch(params: Record<string, unknown>): Sketch {
  return {
    anchor: null,
    columns: [{
      name: 'main',
      chain: [
        { type: 'texture_input', id: 'in' },
        {
          type: 'module',
          module_type: 'video.shape_fold',
          instance_key: 'sf@0',
          params,
        },
        { type: 'texture_output', id: 'out' },
      ],
    }],
  };
}

async function render(sketchId: string, params: Record<string, unknown>, dumpName: string,
                      waitFrames = 6) {
  const result = await runEngineTest({
    width: 96, height: 96,
    modules: ['com.nattos.testonly', 'com.nattos.nano'],
    commands: [
      { type: 'createSketch', sketchId, sketch: buildSketch(params) },
      { type: 'setTracePoints', tracePoints: [
        { id: 'out', target: { type: 'sketch_output', sketchId } },
      ]},
    ],
    waitFrames,
    captureTraceIds: ['out'],
    dumpName,
  });
  expect(result.success).toBe(true);
  return result;
}

// A busy, high-contrast cell, frozen in time for determinism.
const BUSY = { frequency: 0.7, simplicity: 0.35, time_speed: 0.0 };

describe('video.shape_fold E2E', () => {
  jest.setTimeout(60000);

  it('registers and renders a non-solid auto-leveled field', async () => {
    const result = await render('sf_smoke', BUSY, 'sf_smoke');
    // The four-pass auto-levels pipeline produced a structured field.
    result.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);

    // Registration: the effect is present with its broadcast outputs declared.
    const sf = result.state.plugins.find((p: any) => p.id === 'video.shape_fold');
    expect(sf).toBeTruthy();
    expect(sf.io.find((io: any) => io.name === 'autopilot_x' && io.kind === 2)).toBeTruthy();
    expect(sf.io.find((io: any) => io.name === 'autopilot_y' && io.kind === 2)).toBeTruthy();
  });

  it('output_mode changes the encoding (Grayscale vs Magma)', async () => {
    const gray = await render('sf_gray', { ...BUSY, output_mode: 0 }, 'sf_gray');
    const magma = await render('sf_magma', { ...BUSY, output_mode: 1 }, 'sf_magma');
    magma.trace('out').expectDifferentFrom(gray.trace('out'), 50);
  });

  it('colour grading modes are each distinct', async () => {
    const names = ['gray', 'magma', 'inferno', 'viridis', 'plasma', 'turbo'];
    const frames = [];
    for (let m = 0; m < names.length; m++) {
      const r = await render(`sf_cg_${names[m]}`, { ...BUSY, output_mode: m }, `sf_cg_${names[m]}`);
      frames.push(r.trace('out'));
    }
    // Each colormap differs meaningfully from its neighbours.
    for (let m = 1; m < frames.length; m++) {
      frames[m].expectDifferentFrom(frames[m - 1], 40);
    }
  });

  it('covers a non-square viewport (no letterbox bars)', async () => {
    // 2:1 viewport. Under cover the square fills the full width (cropped
    // vertically), so the left/right edge columns show pattern — not the solid
    // black bars a letterbox/fit would leave there.
    const result = await runEngineTest({
      width: 128, height: 64,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      commands: [
        { type: 'createSketch', sketchId: 'sf_wide', sketch: buildSketch(BUSY) },
        { type: 'setTracePoints', tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'sf_wide' } },
        ]},
      ],
      waitFrames: 6, captureTraceIds: ['out'], dumpName: 'sf_wide',
    });
    expect(result.success).toBe(true);
    // Count lit pixels in the 6px-wide left/right edge bands. Under a letterbox
    // these would be solid-black bars (~0 lit); under cover they show pattern.
    let leftLit = 0, rightLit = 0;
    result.trace('out').forEachPixel((c: any, x: number) => {
      const lit = c.r > 12 || c.g > 12 || c.b > 12;
      if (lit && x < 6) leftLit++;
      if (lit && x >= 122) rightLit++;
    });
    expect(leftLit).toBeGreaterThan(40);
    expect(rightLit).toBeGreaterThan(40);
  });

  it('exposure drives the value before grading (boost vs reduce)', async () => {
    const lo = await render('sf_exp_lo', { ...BUSY, exposure: 0.5 }, 'sf_exp_lo');
    const hi = await render('sf_exp_hi', { ...BUSY, exposure: 2.5 }, 'sf_exp_hi');
    hi.trace('out').expectDifferentFrom(lo.trace('out'), 50);
  });

  it('scale (domain zoom) changes the output', async () => {
    const near = await render('sf_scale1', { ...BUSY, scale: 1.0 }, 'sf_scale1');
    const far  = await render('sf_scale4', { ...BUSY, scale: 4.0 }, 'sf_scale4');
    far.trace('out').expectDifferentFrom(near.trace('out'), 40);
  });

  it('autopilot drives a live, non-destructive XY override (clock frozen)', async () => {
    // time_speed=0 freezes the loop, so any change across phases is the
    // autopilot epicycle moving the effective XY — never the inputs.
    const moving = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      dumpName: 'sf_ap_on',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'sf_ap_on',
              sketch: buildSketch({ frequency: 0.5, simplicity: 0.5, time_speed: 0.0,
                                    autopilot: true, ap_speed: 1.0 }) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'sf_ap_on' } },
            ]},
          ],
          waitFrames: 2, captureTraceIds: ['out'],
        },
        { waitFrames: 40, captureTraceIds: ['out'] },
      ],
    });
    expect(moving.success).toBe(true);
    moving.phases[1].trace('out').expectDifferentFrom(moving.phases[0].trace('out'), 30);

    // Control: autopilot off + frozen clock → static across the same span.
    const still = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      dumpName: 'sf_ap_off',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'sf_ap_off',
              sketch: buildSketch({ frequency: 0.5, simplicity: 0.5, time_speed: 0.0,
                                    autopilot: false }) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'sf_ap_off' } },
            ]},
          ],
          waitFrames: 2, captureTraceIds: ['out'],
        },
        { waitFrames: 40, captureTraceIds: ['out'] },
      ],
    });
    expect(still.success).toBe(true);
    still.phases[1].trace('out').expectSameAs(still.phases[0].trace('out'), 2); // frozen → identical
  });

  it('snap with Hold=0 holds until the jump trigger fires', async () => {
    // autopilot + snap, Hold=0 (no auto-jump), clock frozen. The held point must
    // persist across frames, then change the moment the ap_jump trigger fires.
    const r = await runEngineMultiPhaseTest({
      width: 96, height: 96,
      modules: ['com.nattos.testonly', 'com.nattos.nano'],
      dumpName: 'sf_jump',
      phases: [
        {
          commands: [
            { type: 'createSketch', sketchId: 'sf_jump',
              sketch: buildSketch({ frequency: 0.5, simplicity: 0.5, time_speed: 0.0,
                                    autopilot: true, ap_snap: true, ap_hold_period: 0.0,
                                    ap_speed: 0.2 }) },
            { type: 'setTracePoints', tracePoints: [
              { id: 'out', target: { type: 'sketch_output', sketchId: 'sf_jump' } },
            ]},
          ],
          waitFrames: 4, captureTraceIds: ['out'],
        },
        // No trigger: Hold=0 → the held point persists.
        { waitFrames: 25, captureTraceIds: ['out'] },
        // Fire the jump trigger → switch to a fresh point.
        {
          commands: [
            { type: 'setParam', sketchId: 'sf_jump', colIdx: 0, chainIdx: 1,
              paramKey: 'ap_jump', value: 1.0 },
          ],
          waitFrames: 8, captureTraceIds: ['out'],
        },
      ],
    });
    expect(r.success).toBe(true);
    r.phases[1].trace('out').expectSameAs(r.phases[0].trace('out'), 2);        // held
    r.phases[2].trace('out').expectDifferentFrom(r.phases[0].trace('out'), 30); // jumped
  });
});
