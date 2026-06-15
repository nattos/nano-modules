import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * B4 parity: the unified executor.wasm (the SAME C++ binary the native barrel
 * runs, driven via executor-host.ts) must render a sketch pixel-identically to
 * the TypeScript SketchExecutor it replaces. We render each sketch twice through
 * the real engine worker — once on the TS executor (default), once with the wasm
 * executor toggled on (setWasmExecutor) — and diff the sketch-output frames.
 */
describe('Unified executor.wasm parity', () => {
  jest.setTimeout(90000);

  async function render(name: string, sketch: Sketch, modules: string[], useWasm: boolean) {
    const commands: any[] = [{ type: 'createSketch', sketchId: 's', sketch }];
    if (useWasm) commands.push({ type: 'setWasmExecutor', on: true });
    return runEngineTest({
      width: 64, height: 64,
      modules,
      commands,
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 's' } }],
      captureTraceIds: ['out'],
      waitFrames: 30,
      dumpName: `${name}_${useWasm ? 'wasm' : 'ts'}`,
    });
  }

  function diffFraction(a: Uint8Array, b: Uint8Array): number {
    expect(a.length).toBe(b.length);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2) diff++;
    return diff / a.length;
  }

  it('brightness/contrast chain matches the TS executor', async () => {
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'generator.solid_color', instance_key: 'src@0',
          params: { color: [0.4, 0.4, 0.4] } },
        { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0',
          params: { brightness: 0.75, contrast: 0.5 } },
      ],
      wires: [],
    } as Sketch;
    const modules = ['generator.solid_color', 'video.brightness_contrast'];

    const ts = await render('bc', sketch, modules, false);
    const wasm = await render('bc', sketch, modules, true);
    expect(ts.success).toBe(true);
    expect(wasm.success).toBe(true);
    const frac = diffFraction(ts.trace('out').pixels, wasm.trace('out').pixels);
    console.log('[parity] brightness chain diff fraction:', frac);
    expect(frac).toBeLessThan(0.01);
  });

  it('texture-wire blend matches the TS executor', async () => {
    const sketch: Sketch = {
      anchor: null,
      chain: [
        { type: 'module', module_type: 'generator.solid_color', instance_key: 'red@0',
          params: { color: [1.0, 0.0, 0.0] } },
        { type: 'module', module_type: 'generator.solid_color', instance_key: 'blue@0',
          params: { color: [0.0, 0.0, 1.0] } },
        { type: 'module', module_type: 'video.blend', instance_key: 'blend@0',
          params: { opacity: 0.5 } },
      ],
      wires: [
        { id: 'w0', src: { instanceKey: 'red@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '0' } },
        { id: 'w1', src: { instanceKey: 'blue@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '1' } },
      ],
    } as Sketch;
    const modules = ['generator.solid_color', 'video.blend'];

    const ts = await render('blend', sketch, modules, false);
    const wasm = await render('blend', sketch, modules, true);
    expect(ts.success).toBe(true);
    expect(wasm.success).toBe(true);
    const frac = diffFraction(ts.trace('out').pixels, wasm.trace('out').pixels);
    console.log('[parity] blend diff fraction:', frac);
    expect(frac).toBeLessThan(0.01);
  });
});
