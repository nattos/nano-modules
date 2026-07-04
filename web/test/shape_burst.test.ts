import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E coverage for source.shape_burst (nano bundle) — the triggered expanding-
 * ring generator. Each trigger fires a ring (circle / square / triangle) that
 * grows min→max scale over a duration; a `manual` 0..1 knob drives one always-on
 * ring directly, so tests can render a deterministic ring with no trigger timing.
 *
 * Under test:
 *  1. Registers + renders: manual=0.5 over a Black composite draws a non-black ring.
 *  2. All three shapes render (circle/square/triangle), and differ from each other.
 *  3. Composite=Input passes the input through everywhere but the ring.
 *  4. auto_rate self-fires: over several frames the generator produces output.
 */
function burstChain(params: Record<string, unknown>, withInput = false): Sketch['chain'] {
  const chain: Sketch['chain'] = [];
  if (withInput) {
    chain.push({
      type: 'module',
      module_type: 'source.solid_color',
      instance_key: 'bg@0',
      params: { color: [0.2, 0.4, 0.8] },
    });
  }
  chain.push({
    type: 'module',
    module_type: 'source.shape_burst',
    instance_key: 'burst@0',
    params,
  });
  return chain;
}

function buildSketch(params: Record<string, unknown>, withInput = false): Sketch {
  return { anchor: null, chain: burstChain(params, withInput) };
}

async function render(sketchId: string, params: Record<string, unknown>, dumpName: string,
                      withInput = false, waitFrames = 4) {
  const result = await runEngineTest({
    width: 96, height: 96,
    modules: ['com.nano.testonly', 'com.nano.nano'],
    commands: [
      { type: 'createSketch', sketchId, sketch: buildSketch(params, withInput) },
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

// Visible ring: thick stroke, mid scale, opaque white.
const RING = { thickness: 0.1, min_scale: 0.1, max_scale: 1.0, color: [1, 1, 1, 1], manual: 0.5 };

describe('source.shape_burst E2E', () => {
  jest.setTimeout(60000);

  it('registers and renders a manual-driven ring', async () => {
    const r = await render('burst_smoke', { ...RING, composite: 0 /* Black */ }, 'burst_smoke');
    r.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);

    const burst = r.state.plugins.find((p: any) => p.id === 'source.shape_burst');
    expect(burst).toBeTruthy();
  });

  it('renders all three shapes, each distinct', async () => {
    const circle = await render('burst_circle', { ...RING, shape: 0, composite: 0 }, 'burst_circle');
    const square = await render('burst_square', { ...RING, shape: 1, composite: 0 }, 'burst_square');
    const triangle = await render('burst_triangle', { ...RING, shape: 2, composite: 0 }, 'burst_triangle');
    for (const f of [circle, square, triangle]) {
      f.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
    }
    circle.trace('out').expectDifferentFrom(square.trace('out'), 20);
    square.trace('out').expectDifferentFrom(triangle.trace('out'), 20);
  });

  it('Input composite passes the input through around the ring', async () => {
    // Thin ring so most of the frame is the untouched input colour (0.2,0.4,0.8).
    const r = await render('burst_input',
      { ...RING, thickness: 0.03, composite: 3 /* Input */ }, 'burst_input', /*withInput=*/true);
    // A clear majority of pixels should still read as the blue input.
    r.trace('out').expectCoverage(
      (c) => Math.abs(c.r - 51) < 25 && Math.abs(c.g - 102) < 25 && Math.abs(c.b - 204) < 25,
      { min: 0.6 });
    // ...but the ring itself puts some near-white pixels on screen.
    r.trace('out').expectCoverage((c) => c.r > 200 && c.g > 200 && c.b > 200, { min: 0.001 });
  });

  it('auto_rate self-fires and produces output', async () => {
    // No manual voice; rely on Poisson auto-trigger over several frames.
    const r = await render('burst_auto',
      { thickness: 0.1, min_scale: 0.1, max_scale: 1.0, color: [1, 1, 1, 1],
        manual: 0, auto_rate: 1.0, composite: 0 },
      'burst_auto', /*withInput=*/false, /*waitFrames=*/16);
    r.trace('out').expectNotSolidColor({ r: 0, g: 0, b: 0 }, 5);
  });
});
