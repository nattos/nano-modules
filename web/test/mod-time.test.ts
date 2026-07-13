import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.source.time SOURCE node — the transport as modulation:
 * `output` is the looping phase fraction fract(t/period) (always cycling),
 * `value` is the raw beats/seconds — wrapped into the loop when `loop` is on,
 * absolute when off.
 *
 * Probe chain: white solid → mod.source.time → brightness_contrast, with the
 * chosen output wired into bc.brightness (combine:'replace', unsigned): with
 * contrast -0.5 on white input, display ≈ clamp01(raw)*255 linearly. Note the
 * magnitude fold takes the RAW output value (an output's declared [min,max] is
 * the UI-band contract, not a normalizer), so absolute seconds/beats > 1
 * saturate the probe at white — which several tests exploit.
 *
 * The harness runs on the real free-run engine clock (dt = wall rAF deltas;
 * transport faked at 120 BPM), so assertions are ordering/threshold based,
 * never exact-time.
 */
describe('mod.source.time source node E2E', () => {
  jest.setTimeout(60000);

  const build = (params: Record<string, number | boolean>, field: string): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.source.time', instance_key: 'tm@0',
        params },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'tm@0', field },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, params: Record<string, number | boolean>, field: string, waitFrames: number) =>
    runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: id, sketch: build(params, field) }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames,
      dumpName: id,
    });

  it('defaults (Beats + Locked, loop over one bar) publish a valid phase', async () => {
    // The phase's position within the fake 120-BPM bar is wall-clock dependent
    // — assert the wire folds a sane gray (uniform, in range), i.e. the node
    // registered, ticked, and published.
    const r = await run('tm_smoke', {}, 'output', 20);
    expect(r.success).toBe(true);
    const c = r.trace('out').averageColor();
    expect(c.r).toBe(c.g);
    expect(c.r).toBe(c.b);
    expect(c.a).toBe(255);
  });

  it('loop OFF reports the absolute value; loop ON wraps it into the period', async () => {
    // Time + Free. Absolute seconds exceed 1.0 within the run → the raw fold
    // saturates the probe at white. Wrapped into a 0.05 s loop the value stays
    // < 0.05 → near black. This is the loop toggle, end-to-end.
    const abs = await run('tm_abs', { domain: 0, sync: 0, loop: false }, 'value', 300);
    const wrap = await run('tm_wrap', { domain: 0, sync: 0, loop: true, period_seconds: 0.05 }, 'value', 300);
    expect(abs.success && wrap.success).toBe(true);
    expect(abs.trace('out').averageColor().r).toBeGreaterThan(200);
    expect(wrap.trace('out').averageColor().r).toBeLessThan(40);
  });

  it('free time integrates monotonically forward (phase grows against a long period)', async () => {
    // Time + Free, phase against a 10 s period: two captures in one run — the
    // later one must be brighter (phase strictly grew), and far from a wrap.
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'tm_mono',
              sketch: build({ domain: 0, sync: 0, loop: true, period_seconds: 10 }, 'output') },
            { type: 'setTracePoints', tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'tm_mono' } }] },
          ],
          waitFrames: 20, captureTraceIds: ['out'] },
        { commands: [], waitFrames: 180, captureTraceIds: ['out'] },
      ],
      dumpName: 'tm_mono',
    });
    expect(r.success).toBe(true);
    const early = r.phases[0].trace('out').averageColor().r;
    const late = r.phases[1].trace('out').averageColor().r;
    expect(late).toBeGreaterThan(early + 10);
    expect(late).toBeLessThan(250);   // nowhere near a 10 s wrap
  });

  it('the beats domain wraps value by a period in beats', async () => {
    // Beats + Free at the fake 120 BPM: absolute beats pass 1.0 well inside
    // the run (white), while a 1/4-beat loop keeps the wrapped value < 0.25.
    const abs = await run('tm_babs', { domain: 1, sync: 0, loop: false }, 'value', 300);
    const wrap = await run('tm_bwrap', { domain: 1, sync: 0, loop: true, period_beats: 0.25 }, 'value', 300);
    expect(abs.success && wrap.success).toBe(true);
    expect(abs.trace('out').averageColor().r).toBeGreaterThan(200);
    expect(wrap.trace('out').averageColor().r).toBeLessThan(80);
  });

  it('locked beats track the host bar phase (period 4 + loop rides the bar)', async () => {
    // Beats + Locked over one bar: the phase equals the host's bar phase. Two
    // instances created at DIFFERENT times must still paint the SAME value on
    // the same frame — locked clocks re-anchor to the host, they don't carry a
    // creation-time offset. (A Free clock started later would lag.)
    const r = await runEngineMultiPhaseTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      phases: [
        { commands: [
            { type: 'createSketch', sketchId: 'tm_lk1', sketch: build({ domain: 1, sync: 1, loop: true, period_beats: 4 }, 'output') },
          ],
          waitFrames: 30 },
        { commands: [
            { type: 'createSketch', sketchId: 'tm_lk2', sketch: build({ domain: 1, sync: 1, loop: true, period_beats: 4 }, 'output') },
            { type: 'setTracePoints', tracePoints: [
              { id: 'a', target: { type: 'sketch_output', sketchId: 'tm_lk1' } },
              { id: 'b', target: { type: 'sketch_output', sketchId: 'tm_lk2' } },
            ] },
          ],
          waitFrames: 30, captureTraceIds: ['a', 'b'] },
      ],
      dumpName: 'tm_locked',
    });
    expect(r.success).toBe(true);
    const a = r.phases[1].trace('a').averageColor().r;
    const b = r.phases[1].trace('b').averageColor().r;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(6);
  });
});
