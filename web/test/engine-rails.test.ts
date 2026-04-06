import { runEngineTest, runEngineMultiPhaseTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

describe('Sideband Rail Routing E2E', () => {
  jest.setTimeout(30000);

  describe('solid_color module', () => {
    it('renders a solid red color', async () => {
      const result = await runEngineTest({
        modules: ['com.nattos.solid_color'],
        tracePoints: [
          { id: 'out', target: { type: 'plugin_output', pluginKey: 'com.nattos.solid_color@0' } },
        ],
        commands: [
          // Set red=1, green=0, blue=0 via sketch with taps... actually just use
          // a sketch that sets params directly
          {
            type: 'createSketch',
            sketchId: 'sc_test',
            sketch: {
              anchor: 'com.nattos.solid_color@0',
              columns: [{
                name: 'main',
                chain: [
                  { type: 'texture_input', id: 'in' },
                  { type: 'texture_output', id: 'out' },
                ],
              }],
            } as Sketch,
          },
          { type: 'setTracePoints', tracePoints: [
            { id: 'out', target: { type: 'plugin_output', pluginKey: 'com.nattos.solid_color@0' } },
          ]},
        ],
        waitFrames: 15,
        captureTraceIds: ['out'],
        dumpName: 'rail_solid_color',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('out');
      // Default color is (0.5, 0.5, 0.5) → (128, 128, 128)
      frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128 }, 10);
    });
  });

  describe('data rail: LFO → solid_color', () => {
    it('LFO modulates solid color red channel via rail', async () => {
      // Create a sketch with:
      // - env.lfo instance that writes its output to a "lfo_out" rail
      // - source.solid_color instance that reads from "lfo_out" into its Red param
      const sketch: Sketch = {
        anchor: null,
        columns: [{
          name: 'main',
          rails: [
            { id: 'lfo_out', dataType: 'float' },
          ],
          chain: [
            { type: 'texture_input', id: 'in' },
            {
              type: 'module',
              module_type: 'com.nattos.env_lfo',
              instance_key: 'lfo@0',
              params: { rate: 0.5, amplitude: 1.0 },
              taps: [
                { railId: 'lfo_out', fieldPath: 'output', direction: 'write' },
              ],
            },
            {
              type: 'module',
              module_type: 'com.nattos.solid_color',
              instance_key: 'color@0',
              params: { red: 0.0, green: 0.0, blue: 0.0 },
              taps: [
                { railId: 'lfo_out', fieldPath: '0', direction: 'read' }, // LFO → Red param
              ],
            },
            { type: 'texture_output', id: 'out' },
          ],
        }],
      };

      // Capture at two different times to see modulation
      const result = await runEngineMultiPhaseTest({
        width: 64, height: 64,
        modules: ['com.nattos.env_lfo', 'com.nattos.solid_color'],
        dumpName: 'rail_lfo_color',
        phases: [
          {
            commands: [
              { type: 'createSketch', sketchId: 'lfo_sketch', sketch },
              { type: 'setTracePoints', tracePoints: [
                { id: 'out', target: { type: 'sketch_output', sketchId: 'lfo_sketch' } },
              ]},
            ],
            waitFrames: 10,
            captureTraceIds: ['out'],
          },
          {
            commands: [],
            waitFrames: 30, // wait more frames for LFO to change
            captureTraceIds: ['out'],
          },
        ],
      });

      expect(result.success).toBe(true);
      const phase0 = result.phases[0].trace('out');
      const phase1 = result.phases[1].trace('out');

      // Both frames should have color (LFO output goes to Red, Green=0, Blue=0)
      // The red channel should change between the two captures
      const avg0 = phase0.averageColor();
      const avg1 = phase1.averageColor();

      // Green and Blue should be near 0 (we set them to 0)
      expect(avg0.g).toBeLessThan(10);
      expect(avg0.b).toBeLessThan(10);

      // Red should be non-zero (LFO output is in 0-1 range)
      // At least one of the two captures should have visible red
      expect(avg0.r + avg1.r).toBeGreaterThan(10);

      // The two frames should differ (LFO is oscillating)
      phase1.expectDifferentFrom(phase0, 10);
    });
  });

  describe('texture rail: two solid_colors → video.blend', () => {
    it('blends red and blue into purple via texture rails', async () => {
      const sketch: Sketch = {
        anchor: null,
        columns: [{
          name: 'main',
          rails: [
            { id: 'tex_a', dataType: 'texture' },
            { id: 'tex_b', dataType: 'texture' },
          ],
          chain: [
            { type: 'texture_input', id: 'in' },
            // Red solid color → writes texture to rail "tex_a"
            {
              type: 'module',
              module_type: 'com.nattos.solid_color',
              instance_key: 'red@0',
              params: { red: 1.0, green: 0.0, blue: 0.0 }, // pure red
              taps: [
                { railId: 'tex_a', fieldPath: 'texture_out/0', direction: 'write' },
              ],
            },
            // Blue solid color → writes texture to rail "tex_b"
            {
              type: 'module',
              module_type: 'com.nattos.solid_color',
              instance_key: 'blue@0',
              params: { red: 0.0, green: 0.0, blue: 1.0 }, // pure blue
              taps: [
                { railId: 'tex_b', fieldPath: 'texture_out/0', direction: 'write' },
              ],
            },
            // Blend reads both texture rails
            {
              type: 'module',
              module_type: 'com.nattos.video_blend',
              instance_key: 'blend@0',
              params: { opacity: 0.5 }, // 50% opacity blend
              taps: [
                { railId: 'tex_a', fieldPath: '0', direction: 'read' }, // input texture 0
                { railId: 'tex_b', fieldPath: '1', direction: 'read' }, // input texture 1
              ],
            },
            { type: 'texture_output', id: 'out' },
          ],
        }],
      };

      const result = await runEngineTest({
        width: 64, height: 64,
        modules: [
          'com.nattos.solid_color',
          'com.nattos.video_blend',
        ],
        tracePoints: [
          { id: 'blend_out', target: { type: 'sketch_output', sketchId: 'blend_sketch' } },
        ],
        commands: [
          { type: 'createSketch', sketchId: 'blend_sketch', sketch },
        ],
        captureTraceIds: ['blend_out'],
        waitFrames: 20,
        dumpName: 'rail_blend',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('blend_out');

      // 50% blend of red (255,0,0) and blue (0,0,255) should be purple (128,0,128)
      frame.expectPixelAt(32, 32, { r: 128, g: 0, b: 128 }, 15);
    });
  });

  describe('cross-cutting texture rails across columns', () => {
    it('blends red (col 1) and blue (col 2) via sketch-scoped rails', async () => {
      // Red solid color in column 0, writes to sketch-scoped "tex_a" rail.
      // Blue solid color in column 1, writes to sketch-scoped "tex_b" rail.
      // Blend in column 1 (after blue), reads both rails.
      // Columns execute left-to-right, so red is available when blend runs.
      const sketch: Sketch = {
        anchor: null,
        rails: [
          { id: 'tex_a', dataType: 'texture' },
          { id: 'tex_b', dataType: 'texture' },
        ],
        columns: [
          {
            name: 'col_red',
            chain: [
              { type: 'texture_input', id: 'in' },
              {
                type: 'module',
                module_type: 'com.nattos.solid_color',
                instance_key: 'red_cross@0',
                params: { red: 1.0, green: 0.0, blue: 0.0 },
                taps: [
                  { railId: 'tex_a', fieldPath: 'texture_out/0', direction: 'write' },
                ],
              },
              { type: 'texture_output', id: 'out' },
            ],
          },
          {
            name: 'col_blue_blend',
            chain: [
              { type: 'texture_input', id: 'in' },
              {
                type: 'module',
                module_type: 'com.nattos.solid_color',
                instance_key: 'blue_cross@0',
                params: { red: 0.0, green: 0.0, blue: 1.0 },
                taps: [
                  { railId: 'tex_b', fieldPath: 'texture_out/0', direction: 'write' },
                ],
              },
              {
                type: 'module',
                module_type: 'com.nattos.video_blend',
                instance_key: 'blend_cross@0',
                params: { opacity: 0.5 },
                taps: [
                  { railId: 'tex_a', fieldPath: '0', direction: 'read' },
                  { railId: 'tex_b', fieldPath: '1', direction: 'read' },
                ],
              },
              { type: 'texture_output', id: 'out' },
            ],
          },
        ],
      };

      const result = await runEngineTest({
        width: 64, height: 64,
        modules: [
          'com.nattos.solid_color',
          'com.nattos.video_blend',
        ],
        tracePoints: [
          { id: 'blend_out', target: { type: 'sketch_output', sketchId: 'cross_sketch' } },
        ],
        commands: [
          { type: 'createSketch', sketchId: 'cross_sketch', sketch },
        ],
        captureTraceIds: ['blend_out'],
        waitFrames: 20,
        dumpName: 'rail_cross_blend',
      });

      expect(result.success).toBe(true);
      const frame = result.trace('blend_out');

      // 50% blend of red (255,0,0) and blue (0,0,255) should be purple (128,0,128)
      frame.expectPixelAt(32, 32, { r: 128, g: 0, b: 128 }, 15);
    });
  });
});
