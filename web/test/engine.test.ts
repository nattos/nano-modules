import { runEngineTest } from './engine-test-helpers';

describe('Engine Worker E2E', () => {
  jest.setTimeout(30000);

  describe('single real plugin', () => {
    it('ticks and traces output from spinningtris', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.spinningtris'],
        tracePoints: [
          { id: 'main', target: { type: 'plugin_output', pluginKey: 'com.nattos.spinningtris@0' } },
        ],
        captureTraceIds: ['main'],
        dumpName: 'engine_spinningtris',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('main');

      // spinningtris renders colored triangles on a dark background
      const bg = { r: 13, g: 13, b: 20 };
      frame.expectNotSolidColor(bg);
      frame.expectCoverage(
        c => c.r > 25 || c.g > 25 || c.b > 30,
        { min: 0.05 },
      );
    });

    it('ticks and traces output from gpu_test (solid blue)', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.gpu_test'],
        tracePoints: [
          { id: 'main', target: { type: 'plugin_output', pluginKey: 'com.nattos.gpu_test@0' } },
        ],
        captureTraceIds: ['main'],
        dumpName: 'engine_gpu_test',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('main');

      // gpu_test fills with (0, 128, 255)
      frame.expectPixelAt(32, 32, { r: 0, g: 128, b: 255 }, 10);
    });

    it('reports correct plugin metadata in state', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.spinningtris'],
        tracePoints: [],
        waitFrames: 5,
        dumpName: 'engine_metadata',
      });

      expect(result.success).toBe(true);
      expect(result.state).toBeTruthy();
      expect(result.state.plugins.length).toBeGreaterThanOrEqual(1);

      const st = result.state.plugins.find((p: any) => p.id === 'com.nattos.spinningtris');
      expect(st).toBeTruthy();
      expect(st.key).toBe('com.nattos.spinningtris@0');
      expect(st.params.length).toBe(2);
      expect(st.params[0].name).toBe('Triangles');
      expect(st.params[1].name).toBe('Speed');
    });
  });

  describe('multiple real plugins', () => {
    it('traces different outputs from different plugins', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.spinningtris', 'com.nattos.gpu_test'],
        tracePoints: [
          { id: 'tris', target: { type: 'plugin_output', pluginKey: 'com.nattos.spinningtris@0' } },
          { id: 'blue', target: { type: 'plugin_output', pluginKey: 'com.nattos.gpu_test@0' } },
        ],
        captureTraceIds: ['tris', 'blue'],
        waitFrames: 15,
        dumpName: 'engine_multi',
      });

      expect(result.success).toBe(true);

      // Both traces should exist
      const tris = result.trace('tris');
      const blue = result.trace('blue');

      // They should be different images
      tris.expectDifferentFrom(blue, 50);

      // gpu_test should be solid blue
      blue.expectPixelAt(32, 32, { r: 0, g: 128, b: 255 }, 10);

      // spinningtris should have some non-background content
      tris.expectNotSolidColor({ r: 0, g: 128, b: 255 });
    });
  });

  describe('sketch with brightness_contrast', () => {
    it('applies contrast reduction to spinningtris', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.spinningtris', 'com.nattos.brightness_contrast'],
        tracePoints: [
          { id: 'raw', target: { type: 'plugin_output', pluginKey: 'com.nattos.spinningtris@0' } },
          { id: 'processed', target: { type: 'sketch_output', sketchId: 'test_sketch' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'test_sketch',
            sketch: {
              anchor: 'com.nattos.spinningtris@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'primary_in' },
                  {
                    type: 'module',
                    module_type: 'com.nattos.brightness_contrast',
                    instance_key: 'virtual_bc@0',
                    params: { '0': 0.5, '1': 0.25 },  // neutral brightness, half contrast
                  },
                  { type: 'texture_output', id: 'primary_out' },
                ],
              }],
            },
          },
        ],
        captureTraceIds: ['raw', 'processed'],
        waitFrames: 20,
        dumpName: 'engine_sketch_bc',
      });

      expect(result.success).toBe(true);

      const raw = result.trace('raw');
      const processed = result.trace('processed');

      // The processed output should be darker (contrast halved)
      const rawAvg = raw.averageColor();
      const procAvg = processed.averageColor();
      expect(procAvg.r).toBeLessThan(rawAvg.r + 5);
      expect(procAvg.g).toBeLessThan(rawAvg.g + 5);
      expect(procAvg.b).toBeLessThan(rawAvg.b + 5);

      // They should be visually different
      processed.expectDifferentFrom(raw, 50);
    });

    it('contrast=0 produces black', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.spinningtris', 'com.nattos.brightness_contrast'],
        tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'black_sketch' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'black_sketch',
            sketch: {
              anchor: 'com.nattos.spinningtris@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'primary_in' },
                  {
                    type: 'module',
                    module_type: 'com.nattos.brightness_contrast',
                    instance_key: 'virtual_bc_black@0',
                    params: { '0': 0.5, '1': 0.0 },  // contrast=0 → black
                  },
                  { type: 'texture_output', id: 'primary_out' },
                ],
              }],
            },
          },
        ],
        captureTraceIds: ['out'],
        waitFrames: 20,
        dumpName: 'engine_sketch_black',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('out');
      frame.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
    });
  });
});
