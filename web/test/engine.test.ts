import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';

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
      const paramNames = st.params.map((p: any) => p.name).sort();
      expect(paramNames).toEqual(['speed', 'triangles']);
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

  describe('trace point switching', () => {
    it('switching trace between two plugin outputs shows correct output', async () => {
      // Simpler version: just trace plugin outputs directly (no sketches)
      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['com.nattos.spinningtris', 'com.nattos.gpu_test'],
        dumpName: 'engine_plugin_switch',
        phases: [
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'plugin_output', pluginKey: 'com.nattos.spinningtris@0' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'plugin_output', pluginKey: 'com.nattos.gpu_test@0' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'plugin_output', pluginKey: 'com.nattos.spinningtris@0' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
        ],
      });

      expect(result.success).toBe(true);
      const p0 = result.phases[0].trace('preview'); // spinningtris
      const p1 = result.phases[1].trace('preview'); // gpu_test blue
      const p2 = result.phases[2].trace('preview'); // spinningtris again

      // Phase 1 should be solid blue
      p1.expectPixelAt(32, 32, { r: 0, g: 128, b: 255 }, 10);
      // Phase 0 should NOT be solid blue
      p0.expectNotSolidColor({ r: 0, g: 128, b: 255 });
      // Phase 2 should NOT be solid blue (should be spinningtris again)
      p2.expectNotSolidColor({ r: 0, g: 128, b: 255 });
      p2.expectDifferentFrom(p1, 50);
    });

    it('switching trace between two sketches shows correct output', async () => {
      // Repro: create sketch on spinningtris, trace it. Then create sketch on
      // gpu_test, trace that. Then switch trace back to spinningtris sketch.
      // Bug: switching back shows the gpu_test output instead of spinningtris.

      const trisSketch = {
        anchor: 'com.nattos.spinningtris@0',
        columns: [{ name: 'main', chain: [
          { type: 'texture_input', id: 'in' },
          { type: 'texture_output', id: 'out' },
        ]}],
      };

      const blueSketch = {
        anchor: 'com.nattos.gpu_test@0',
        columns: [{ name: 'main', chain: [
          { type: 'texture_input', id: 'in' },
          { type: 'texture_output', id: 'out' },
        ]}],
      };

      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['com.nattos.spinningtris', 'com.nattos.gpu_test'],
        dumpName: 'engine_trace_switch',
        phases: [
          // Phase 0: Create both sketches, trace the spinningtris sketch
          {
            commands: [
              { type: 'createSketch', sketchId: 'sk_tris', sketch: trisSketch },
              { type: 'createSketch', sketchId: 'sk_blue', sketch: blueSketch },
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'sketch_output', sketchId: 'sk_tris' } },
              ]},
            ],
            waitFrames: 15,
            captureTraceIds: ['preview'],
          },
          // Phase 1: Switch trace to gpu_test sketch
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'sketch_output', sketchId: 'sk_blue' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
          // Phase 2: Switch trace BACK to spinningtris sketch
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'sketch_output', sketchId: 'sk_tris' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.phases.length).toBe(3);

      const phase0 = result.phases[0].trace('preview'); // should be spinningtris
      const phase1 = result.phases[1].trace('preview'); // should be gpu_test (blue)
      const phase2 = result.phases[2].trace('preview'); // should be spinningtris again

      // Phase 1 should be solid blue (gpu_test)
      phase1.expectPixelAt(32, 32, { r: 0, g: 128, b: 255 }, 10);

      // Phase 0 should NOT be solid blue (it's spinningtris)
      phase0.expectNotSolidColor({ r: 0, g: 128, b: 255 });

      // Phase 2 should match phase 0 (spinningtris), NOT phase 1 (blue)
      // The bug would cause phase 2 to look like phase 1
      phase2.expectNotSolidColor({ r: 0, g: 128, b: 255 });
      phase2.expectDifferentFrom(phase1, 50);
    });
  });
});
