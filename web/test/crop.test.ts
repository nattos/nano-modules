import { runGpuEffectTest } from './gpu-test-helpers';

describe('Crop Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'crop.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'crop_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.crop');
  });

  it('default 1x1 crop covers the whole frame (passthrough)', async () => {
    const frame = await runGpuEffectTest({
      module: 'crop.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.7, 0.2, 1.0],
      // Defaults: center 0,0; width 1; height 1; feather 0.02 → covers full square + a bit.
      dumpName: 'crop_full',
    });
    expect(frame.success).toBe(true);
    frame.expectPixelAt(32, 32, { r: 128, g: 178, b: 51 }, 6);
  });

  it('shrinking width clips the sides to transparent black', async () => {
    // center=0, width=0.2, height=1, feather small. The centre pixel should
    // remain inside the rect; far-left/right pixels should be in fill (alpha 0).
    const frame = await runGpuEffectTest({
      module: 'crop.wasm',
      bundle: 'core',
      width: 64, height: 64,
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [['width', 0.2], ['height', 1.0], ['feather', 0.005]],
      samplePoints: [[32, 32], [0, 32], [63, 32]],
      dumpName: 'crop_narrow',
    });
    expect(frame.success).toBe(true);
    const center = frame.samples.find(s => s.x === 32 && s.y === 32)!;
    const left = frame.samples.find(s => s.x === 0 && s.y === 32)!;
    expect(center.r).toBeGreaterThan(200);
    expect(left.a).toBeLessThan(50);
  });

  it('fill colour fills the masked-out region', async () => {
    // width=0, height=0 → nothing inside the rect → entire frame is fill.
    const frame = await runGpuEffectTest({
      module: 'crop.wasm',
      bundle: 'core',
      width: 32, height: 32,
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [
        ['width', 0.0], ['height', 0.0], ['feather', 0.0],
        ['fill', [1.0, 0.0, 0.0, 1.0]],
      ],
      dumpName: 'crop_fill',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 0, b: 0, a: 255 }, 4);
  });
});
