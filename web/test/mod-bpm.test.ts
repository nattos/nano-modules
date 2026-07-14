import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the mod.source.bpm SOURCE node — the host tempo as modulation:
 * `bpm` is the raw BPM, `beat_seconds` is 60/BPM. Both are stateless
 * per-frame host reads, so at the harness's fake 120 BPM they are CONSTANTS
 * (bpm = 120, beat_seconds = 0.5) — assertions can be tight, unlike the
 * phase-based mod.source.time tests.
 *
 * Probe chain (mod-time pattern): white solid → mod.source.bpm →
 * brightness_contrast, output wired into bc.brightness (combine:'replace',
 * unsigned): with contrast -0.5 on white input, display ≈ clamp01(raw)*255.
 * The fold takes the RAW value, so bpm = 120 saturates the probe at white
 * while beat_seconds = 0.5 lands mid-gray.
 */
describe('mod.source.bpm source node E2E', () => {
  jest.setTimeout(60000);

  const build = (field: string): Sketch => ({
    anchor: null,
    chain: [
      { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0',
        params: { color: [1.0, 1.0, 1.0] } },
      { type: 'module', module_type: 'mod.source.bpm', instance_key: 'bpm@0',
        params: {} },
      { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0',
        params: { brightness: 1.0, contrast: -0.5 } },
    ],
    wires: [
      { id: 'w1', src: { instanceKey: 'bpm@0', field },
        dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'replace' },
    ],
  } as Sketch);

  const run = (id: string, field: string) =>
    runEngineTest({
      width: 64, height: 64,
      modules: ['com.nano.core'],
      commands: [{ type: 'createSketch', sketchId: id, sketch: build(field) }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: id } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: id,
    });

  it('bpm publishes the raw host tempo (120 saturates the raw wire fold)', async () => {
    const r = await run('bpm_raw', 'bpm');
    expect(r.success).toBe(true);
    const c = r.trace('out').averageColor();
    expect(c.r).toBeGreaterThan(200);
    expect(c.r).toBe(c.g);
    expect(c.r).toBe(c.b);
  });

  it('beat_seconds publishes 60/BPM (0.5 s at the fake 120 BPM → mid-gray)', async () => {
    const r = await run('bpm_beat', 'beat_seconds');
    expect(r.success).toBe(true);
    const c = r.trace('out').averageColor();
    // clamp01(0.5)*255 ≈ 128, with a little probe-pipeline tolerance.
    expect(c.r).toBeGreaterThan(108);
    expect(c.r).toBeLessThan(148);
    expect(c.r).toBe(c.g);
  });
});
