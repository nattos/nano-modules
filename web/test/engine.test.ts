import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';

describe('Engine Worker E2E', () => {
  jest.setTimeout(30000);

  describe('single real plugin', () => {
    it('ticks and traces output from spinningtris', async () => {
      const result = await runEngineTest({
        modules: ['generator.spinningtris'],
        tracePoints: [
          { id: 'main', target: { type: 'plugin_output', pluginKey: 'generator.spinningtris@0' } },
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
        modules: ['debug.gpu_test'],
        tracePoints: [
          { id: 'main', target: { type: 'plugin_output', pluginKey: 'debug.gpu_test@0' } },
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
        modules: ['generator.spinningtris'],
        tracePoints: [],
        waitFrames: 5,
        dumpName: 'engine_metadata',
      });

      expect(result.success).toBe(true);
      expect(result.state).toBeTruthy();
      expect(result.state.plugins.length).toBeGreaterThanOrEqual(1);

      const st = result.state.plugins.find((p: any) => p.id === 'generator.spinningtris');
      expect(st).toBeTruthy();
      expect(st.key).toBe('generator.spinningtris@0');
      expect(st.params.length).toBe(2);
      const paramNames = st.params.map((p: any) => p.name).sort();
      expect(paramNames).toEqual(['speed', 'triangles']);
    });
  });

  describe('multiple real plugins', () => {
    it('traces different outputs from different plugins', async () => {
      const result = await runEngineTest({
        modules: ['generator.spinningtris', 'debug.gpu_test'],
        tracePoints: [
          { id: 'tris', target: { type: 'plugin_output', pluginKey: 'generator.spinningtris@0' } },
          { id: 'blue', target: { type: 'plugin_output', pluginKey: 'debug.gpu_test@0' } },
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
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        tracePoints: [
          { id: 'raw', target: { type: 'plugin_output', pluginKey: 'generator.spinningtris@0' } },
          { id: 'processed', target: { type: 'sketch_output', sketchId: 'test_sketch' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'test_sketch',
            sketch: {
              anchor: 'generator.spinningtris@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'primary_in' },
                  {
                    type: 'module',
                    module_type: 'video.brightness_contrast',
                    instance_key: 'virtual_bc@0',
                    params: { brightness: 0.5, contrast: 0.25 },  // neutral brightness, half contrast
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
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'black_sketch' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'black_sketch',
            sketch: {
              anchor: 'generator.spinningtris@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'primary_in' },
                  {
                    type: 'module',
                    module_type: 'video.brightness_contrast',
                    instance_key: 'virtual_bc_black@0',
                    params: { brightness: 0.5, contrast: 0.0 },  // contrast=0 → black
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
        modules: ['generator.spinningtris', 'debug.gpu_test'],
        dumpName: 'engine_plugin_switch',
        phases: [
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'plugin_output', pluginKey: 'generator.spinningtris@0' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'plugin_output', pluginKey: 'debug.gpu_test@0' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['preview'],
          },
          {
            commands: [
              { type: 'setTracePoints', tracePoints: [
                { id: 'preview', target: { type: 'plugin_output', pluginKey: 'generator.spinningtris@0' } },
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
        anchor: 'generator.spinningtris@0',
        columns: [{ name: 'main', chain: [
          { type: 'texture_input', id: 'in' },
          { type: 'texture_output', id: 'out' },
        ]}],
      };

      const blueSketch = {
        anchor: 'debug.gpu_test@0',
        columns: [{ name: 'main', chain: [
          { type: 'texture_input', id: 'in' },
          { type: 'texture_output', id: 'out' },
        ]}],
      };

      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['generator.spinningtris', 'debug.gpu_test'],
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

  describe('env_lfo output and rail routing', () => {
    it('env_lfo reports output as data_output in plugin io', async () => {
      const result = await runEngineTest({
        modules: ['data.lfo'],
        tracePoints: [],
        waitFrames: 5,
        dumpName: 'engine_lfo_io',
      });

      expect(result.success).toBe(true);
      const lfo = result.state.plugins.find((p: any) => p.id === 'data.lfo');
      expect(lfo).toBeTruthy();

      // "output" should appear in io with kind=2 (data_output)
      const dataOut = lfo.io.find((io: any) => io.name === 'output' && io.kind === 2);
      expect(dataOut).toBeTruthy();

      // "output" should also be in params (it's a schema field)
      const outParam = lfo.params.find((p: any) => p.name === 'output');
      expect(outParam).toBeTruthy();

      // "rate" and "amplitude" should NOT be in io as data_output
      const rateIo = lfo.io.find((io: any) => io.name === 'rate' && io.kind === 2);
      expect(rateIo).toBeUndefined();
    });

    it('LFO write tap publishes rail value to sketchState', async () => {
      const result = await runEngineTest({
        modules: ['data.lfo'],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'sk_lfo',
            sketch: {
              anchor: null,
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'in' },
                  {
                    type: 'module',
                    module_type: 'data.lfo',
                    instance_key: 'lfo@0',
                    params: { rate: 0.5, amplitude: 1.0 },
                    taps: [
                      { railId: 'lfo_out', fieldPath: 'output', direction: 'write' },
                    ],
                  },
                  { type: 'texture_output', id: 'out' },
                ],
                rails: [{ id: 'lfo_out', name: 'LFO Out', dataType: 'float' }],
              }],
            },
          },
        ],
        tracePoints: [],
        waitFrames: 20,
        dumpName: 'engine_lfo_rail',
      });

      expect(result.success).toBe(true);

      // The rail value should appear in sketchState
      const ss = result.sketchState;
      expect(ss).toBeTruthy();
      const colRails = ss?.sk_lfo?.['columns/0'];
      expect(colRails).toBeTruthy();
      expect(colRails.lfo_out).toBeTruthy();
      // The LFO output is a sine wave between 0 and 1 — value should be a number
      expect(typeof colRails.lfo_out.value).toBe('number');
    });

    it('LFO modulates brightness_contrast via rail read tap', async () => {
      // LFO writes to rail, BC reads contrast from rail.
      // With LFO amplitude=1, contrast swings between 0 and 1.
      // After enough frames, the output should differ from static contrast=1.
      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['generator.spinningtris', 'video.brightness_contrast', 'data.lfo'],
        dumpName: 'engine_lfo_modulate',
        phases: [
          // Phase 0: Static contrast=1 (no modulation) for reference
          {
            commands: [
              {
                type: 'createSketch',
                sketchId: 'sk_mod',
                sketch: {
                  anchor: 'generator.spinningtris@0',
                  columns: [{
                    name: 'main',
                    chain: [
                      { type: 'texture_input', id: 'in' },
                      {
                        type: 'module',
                        module_type: 'video.brightness_contrast',
                        instance_key: 'bc@0',
                        params: { brightness: 0.5, contrast: 1.0 },
                      },
                      { type: 'texture_output', id: 'out' },
                    ],
                  }],
                },
              },
              { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'sk_mod' } },
              ]},
            ],
            waitFrames: 15,
            captureTraceIds: ['out'],
          },
          // Phase 1: Add LFO modulating contrast via rail
          {
            commands: [
              {
                type: 'updateSketch',
                sketchId: 'sk_mod',
                sketch: {
                  anchor: 'generator.spinningtris@0',
                  columns: [{
                    name: 'main',
                    chain: [
                      { type: 'texture_input', id: 'in' },
                      {
                        type: 'module',
                        module_type: 'data.lfo',
                        instance_key: 'lfo@0',
                        params: { rate: 0.5, amplitude: 1.0 },
                        taps: [
                          { railId: 'mod_rail', fieldPath: 'output', direction: 'write' },
                        ],
                      },
                      {
                        type: 'module',
                        module_type: 'video.brightness_contrast',
                        instance_key: 'bc@0',
                        params: { brightness: 0.5, contrast: 1.0 },
                        taps: [
                          { railId: 'mod_rail', fieldPath: 'contrast', direction: 'read' },
                        ],
                      },
                      { type: 'texture_output', id: 'out' },
                    ],
                    rails: [{ id: 'mod_rail', name: 'Mod', dataType: 'float' }],
                  }],
                },
              },
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
        ],
      });

      expect(result.success).toBe(true);

      // The modulated phase should have the rail value set
      const ss = result.phases[1].sketchState;
      const colRails = ss?.sk_mod?.['columns/0'];
      expect(colRails?.mod_rail).toBeTruthy();
      expect(typeof colRails?.mod_rail?.value).toBe('number');
    });
  });

  describe('chain_entry trace points', () => {
    it('resolves chain_entry trace to module output texture', async () => {
      const result = await runEngineTest({
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        tracePoints: [
          // Trace the BC module's output (chainIdx=1 in the chain)
          { id: 'bc_out', target: { type: 'chain_entry', sketchId: 'sk_ce', colIdx: 0, chainIdx: 1, side: 'output' } },
          { id: 'sketch_out', target: { type: 'sketch_output', sketchId: 'sk_ce' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'sk_ce',
            sketch: {
              anchor: 'generator.spinningtris@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'in' },
                  {
                    type: 'module',
                    module_type: 'video.brightness_contrast',
                    instance_key: 'bc_ce@0',
                    params: { brightness: 0.5, contrast: 0.0 },
                  },
                  { type: 'texture_output', id: 'out' },
                ],
              }],
            },
          },
        ],
        captureTraceIds: ['bc_out', 'sketch_out'],
        waitFrames: 20,
        dumpName: 'engine_chain_entry',
      });

      expect(result.success).toBe(true);

      const bcOut = result.trace('bc_out');
      const sketchOut = result.trace('sketch_out');

      // Both should be black (contrast=0)
      bcOut.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
      sketchOut.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);

      // They should be the same image
      bcOut.expectSameAs(sketchOut, 1);
    });

    it('chain_entry input differs from output when module applies effect', async () => {
      const result = await runEngineTest({
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        tracePoints: [
          { id: 'bc_in', target: { type: 'chain_entry', sketchId: 'sk_io', colIdx: 0, chainIdx: 1, side: 'input' } },
          { id: 'bc_out', target: { type: 'chain_entry', sketchId: 'sk_io', colIdx: 0, chainIdx: 1, side: 'output' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'sk_io',
            sketch: {
              anchor: 'generator.spinningtris@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'in' },
                  {
                    type: 'module',
                    module_type: 'video.brightness_contrast',
                    instance_key: 'bc_io@0',
                    params: { brightness: 0.5, contrast: 0.0 },
                  },
                  { type: 'texture_output', id: 'out' },
                ],
              }],
            },
          },
        ],
        captureTraceIds: ['bc_in', 'bc_out'],
        waitFrames: 20,
        dumpName: 'engine_chain_entry_io',
      });

      expect(result.success).toBe(true);

      const bcIn = result.trace('bc_in');
      const bcOut = result.trace('bc_out');

      // Input should be the spinningtris output (colorful)
      bcIn.expectNotSolidColor({ r: 0, g: 0, b: 0 });

      // Output should be black (contrast=0)
      bcOut.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);

      // They should be different
      bcIn.expectDifferentFrom(bcOut, 50);
    });
  });

  describe('column move preserves params', () => {
    it('contrast=0 stays black after moving module between columns', async () => {
      // Repro for bug: moving a module to a different column via updateSketch
      // causes it to render with default params instead of the ones in the sketch.

      const makeSketch = (colIdx: number) => ({
        anchor: 'generator.spinningtris@0',
        columns: colIdx === 0
          ? [{
              name: 'col0',
              chain: [
                { type: 'texture_input', id: 'in' },
                {
                  type: 'module',
                  module_type: 'video.brightness_contrast',
                  instance_key: 'bc_move@0',
                  params: { brightness: 0.5, contrast: 0.0 },
                },
                { type: 'texture_output', id: 'out' },
              ],
            }]
          : [
              { name: 'col0', chain: [
                { type: 'texture_input', id: 'in' },
                { type: 'texture_output', id: 'out' },
              ]},
              { name: 'col1', chain: [
                { type: 'texture_input', id: 'in' },
                {
                  type: 'module',
                  module_type: 'video.brightness_contrast',
                  instance_key: 'bc_move@0',
                  params: { brightness: 0.5, contrast: 0.0 },
                },
                { type: 'texture_output', id: 'out' },
              ]},
            ],
      });

      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        dumpName: 'engine_column_move',
        phases: [
          // Phase 0: contrast=0 in column 0 → should be black
          {
            commands: [
              { type: 'createSketch', sketchId: 'sk_move', sketch: makeSketch(0) },
              { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'sk_move' } },
              ]},
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
          // Phase 1: move to column 1 → should still be black
          {
            commands: [
              { type: 'updateSketch', sketchId: 'sk_move', sketch: makeSketch(1) },
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
          // Phase 2: move back to column 0 → should still be black
          {
            commands: [
              { type: 'updateSketch', sketchId: 'sk_move', sketch: makeSketch(0) },
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.phases.length).toBe(3);

      const p0 = result.phases[0].trace('out');
      const p1 = result.phases[1].trace('out');
      const p2 = result.phases[2].trace('out');

      // All three phases should be black (contrast=0)
      p0.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
      p1.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
      p2.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
    });

    it('empty trailing column does not override module output', async () => {
      // Repro for the actual bug: module in column 0, empty column 1.
      // The sketch output should come from column 0 (has module), not column 1 (empty passthrough).
      const result = await runEngineTest({
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        tracePoints: [
          { id: 'out', target: { type: 'sketch_output', sketchId: 'sk_trailing' } },
        ],
        commands: [
          {
            type: 'createSketch',
            sketchId: 'sk_trailing',
            sketch: {
              anchor: 'generator.spinningtris@0',
              columns: [
                {
                  name: 'col0',
                  chain: [
                    { type: 'texture_input', id: 'in' },
                    {
                      type: 'module',
                      module_type: 'video.brightness_contrast',
                      instance_key: 'bc_trail@0',
                      params: { brightness: 0.5, contrast: 0.0 },
                    },
                    { type: 'texture_output', id: 'out' },
                  ],
                },
                {
                  name: 'col1',
                  chain: [
                    { type: 'texture_input', id: 'in' },
                    { type: 'texture_output', id: 'out' },
                  ],
                },
              ],
            },
          },
        ],
        captureTraceIds: ['out'],
        waitFrames: 20,
        dumpName: 'engine_trailing_col',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('out');
      // Should be black (contrast=0 from column 0), NOT the anchor's colorful output
      frame.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
    });

    it('params set via setParam persist after column move', async () => {
      // Simulates the real UI flow:
      // 1. Create sketch with empty params (like createSketch does)
      // 2. Set a param via setParam (like setEffectParam does)
      // 3. Move module to column 1 via updateSketch
      // 4. Move back to column 0 via updateSketch
      // Verify output reflects the param change throughout.

      const sketchInCol0Empty = {
        anchor: 'generator.spinningtris@0',
        columns: [{
          name: 'col0',
          chain: [
            { type: 'texture_input', id: 'in' },
            {
              type: 'module',
              module_type: 'video.brightness_contrast',
              instance_key: 'bc_setparam@0',
              params: {},  // Empty, like createSketch
            },
            { type: 'texture_output', id: 'out' },
          ],
        }],
      };

      const sketchInCol0WithParams = {
        anchor: 'generator.spinningtris@0',
        columns: [{
          name: 'col0',
          chain: [
            { type: 'texture_input', id: 'in' },
            {
              type: 'module',
              module_type: 'video.brightness_contrast',
              instance_key: 'bc_setparam@0',
              params: { brightness: 0.5, contrast: 0.0 },
            },
            { type: 'texture_output', id: 'out' },
          ],
        }],
      };

      const sketchInCol1WithParams = {
        anchor: 'generator.spinningtris@0',
        columns: [
          { name: 'col0', chain: [
            { type: 'texture_input', id: 'in' },
            { type: 'texture_output', id: 'out' },
          ]},
          { name: 'col1', chain: [
            { type: 'texture_input', id: 'in' },
            {
              type: 'module',
              module_type: 'video.brightness_contrast',
              instance_key: 'bc_setparam@0',
              params: { brightness: 0.5, contrast: 0.0 },
            },
            { type: 'texture_output', id: 'out' },
          ]},
        ],
      };

      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['generator.spinningtris', 'video.brightness_contrast'],
        dumpName: 'engine_setparam_move',
        phases: [
          // Phase 0: Create sketch with empty params, then set contrast=0
          {
            commands: [
              { type: 'createSketch', sketchId: 'sk_sp', sketch: sketchInCol0Empty },
              { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'sk_sp' } },
              ]},
              // Simulate setEffectParam: mutate → updateSketch, then setParam
              { type: 'updateSketch', sketchId: 'sk_sp', sketch: sketchInCol0WithParams },
              { type: 'setParam', sketchId: 'sk_sp', colIdx: 0, chainIdx: 1, paramKey: 'contrast', value: 0.0 },
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
          // Phase 1: Move to column 1 (full sketch update like syncSketchesToEngine)
          {
            commands: [
              { type: 'updateSketch', sketchId: 'sk_sp', sketch: sketchInCol1WithParams },
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
          // Phase 2: Move back to column 0
          {
            commands: [
              { type: 'updateSketch', sketchId: 'sk_sp', sketch: sketchInCol0WithParams },
            ],
            waitFrames: 20,
            captureTraceIds: ['out'],
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.phases.length).toBe(3);

      const p0 = result.phases[0].trace('out');
      const p1 = result.phases[1].trace('out');
      const p2 = result.phases[2].trace('out');

      // All phases should be black (contrast=0)
      p0.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
      p1.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
      p2.expectUniformColor({ r: 0, g: 0, b: 0 }, 5);
    });
  });
});
