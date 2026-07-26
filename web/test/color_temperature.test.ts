import { runGpuEffectTest, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for `color.temperature` against `core`.
// temperature [-1, +1] shifts the per-channel gain on the orange/blue axis:
//   +1 → R * 1.5, B * 0.5 (warm)
//   -1 → R * 0.5, B * 1.5 (cool)
//    0 → pass-through
//
// Param indices (declaration order):
//   0 = temperature

forEachBackend((backend) => {
describe(`Color Temperature Effect E2E (${backend})`, () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.temperature',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'color_temperature_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.temperature');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['temperature']);
  });

  it('temperature=0 passes through unchanged', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.temperature',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [['temperature', 0.0]],
      dumpName: 'color_temperature_zero',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 128, b: 128, a: 255 }, 4);
  });

  it('temperature=+1 pushes red over blue (warm)', async () => {
    // grey 0.5 → R * 1.5 = 192, G unchanged = 128, B * 0.5 = 64
    const frame = await runGpuEffectTest({
      module: 'color.temperature',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [['temperature', 1.0]],
      dumpName: 'color_temperature_warm',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 192, g: 128, b: 64 }, 6);
  });

  it('temperature=-1 pushes blue over red (cool)', async () => {
    // grey 0.5 → R * 0.5 = 64, G unchanged = 128, B * 1.5 = 192
    const frame = await runGpuEffectTest({
      module: 'color.temperature',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      params: [['temperature', -1.0]],
      dumpName: 'color_temperature_cool',
    });

    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 64, g: 128, b: 192 }, 6);
  });
});
});
