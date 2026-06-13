import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

/**
 * E2E for the single-stack WIRE model (replacing taps+rails). Wires connect a
 * producer output field to a consumer input field, addressed by instance_key;
 * causality is positional (producer above → same-frame). This file covers the
 * explicit-wire path; auto-connect + dashboard land with their migrations.
 */
describe('Wire routing E2E', () => {
  jest.setTimeout(30000);

  it('texture fan-out + combine in ONE column via explicit wires', async () => {
    // Single column: red, blue, blend. No rails/taps. Wires fan the two solids
    // into blend's two texture inputs (0,1); both producers are above blend, so
    // the values are read same-frame. 50% blend of red+blue → purple.
    const sketch: Sketch = {
      anchor: null,
      columns: [{
        name: 'main',
        chain: [
          { type: 'module', module_type: 'generator.solid_color', instance_key: 'red@0',
            params: { color: [1.0, 0.0, 0.0] } },
          { type: 'module', module_type: 'generator.solid_color', instance_key: 'blue@0',
            params: { color: [0.0, 0.0, 1.0] } },
          { type: 'module', module_type: 'video.blend', instance_key: 'blend@0',
            params: { opacity: 0.5 } },
        ],
      }],
      wires: [
        { id: 'w0', src: { instanceKey: 'red@0',  field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '0' } },
        { id: 'w1', src: { instanceKey: 'blue@0', field: 'tex_out' }, dest: { instanceKey: 'blend@0', field: '1' } },
      ],
    } as Sketch;

    const result = await runEngineTest({
      width: 64, height: 64,
      modules: ['generator.solid_color', 'video.blend'],
      commands: [{ type: 'createSketch', sketchId: 'wire_blend', sketch }],
      tracePoints: [{ id: 'out', target: { type: 'sketch_output', sketchId: 'wire_blend' } }],
      captureTraceIds: ['out'],
      waitFrames: 20,
      dumpName: 'wire_blend',
    });

    expect(result.success).toBe(true);
    result.trace('out').expectPixelAt(32, 32, { r: 128, g: 0, b: 128 }, 15);
  });
});
