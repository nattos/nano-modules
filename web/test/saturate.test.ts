import { runGpuEffectTest } from './gpu-test-helpers';

// Per-effect tests for `video.saturate` against `core`. The effect is
// a per-channel waveshaper that scales from BLACK (not mid-grey):
//   y = x * prescale                          (prescale=0 → output = 0)
//   y <= dz       :  z = y                    (linear pass-through)
//   y >  dz       :  z = dz + (1 - dz) * tanh((y - dz) / (1 - dz) * 2^asymm)
//   out = z

describe('Saturate Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and three scalar inputs', async () => {
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'saturate_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('video.saturate');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['asymm', 'linear_deadzone', 'prescale']);
  });

  it('prescale=0 collapses any input to pure black', async () => {
    // Headline behaviour the user asked for: prescale=0 zeros every
    // channel before any other curve runs. Should hold for any
    // values of asymm and linear_deadzone too.
    for (const params of [
      [['prescale', 0]],
      [['prescale', 0], ['asymm', 1.0]],
      [['prescale', 0], ['linear_deadzone', 0.7]],
      [['prescale', 0], ['asymm', -1.0], ['linear_deadzone', 0.5]],
    ] as any) {
      const frame = await runGpuEffectTest({
        module: 'saturate.wasm',
        bundle: 'core',
        inputColor: [0.4, 0.6, 0.8, 1.0],
        params,
        dumpName: 'saturate_prescale_zero',
      });
      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 1);
    }
  });

  it('input black is always black', async () => {
    // x = 0 → y = 0 regardless of prescale → in deadzone → out = 0.
    for (const params of [
      [],
      [['prescale', 4.0]],
      [['prescale', 0.5], ['asymm', 0.7]],
      [['linear_deadzone', 0.4]],
    ] as any) {
      const frame = await runGpuEffectTest({
        module: 'saturate.wasm',
        bundle: 'core',
        inputColor: [0, 0, 0, 1.0],
        params,
        dumpName: 'saturate_black_in',
      });
      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 1);
    }
  });

  it('default prescale=1 softens whites (~tanh(1) ≈ 0.762 → 194)', async () => {
    // Default deadzone=0, asymm=0 → out = tanh(x). White → 194.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      dumpName: 'saturate_default_white',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 194, g: 194, b: 194, a: 255 }, 3);
  });

  it('higher prescale crushes whites harder (drive)', async () => {
    // prescale=4: y=4 → tanh(4) ≈ 0.9993 → ~255.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [['prescale', 4.0]],
      dumpName: 'saturate_prescale_high',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 2);
  });

  it('linear_deadzone=1 is a true pass-through', async () => {
    // Whole [0, 1] window inside the deadzone — never reaches the
    // tanh branch.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['linear_deadzone', 1.0]],
      dumpName: 'saturate_deadzone_full',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('linear_deadzone preserves a value below the threshold', async () => {
    // deadzone = 0.5: y in [0, 0.5] passes through. x = 0.4 → y = 0.4
    // → in deadzone → out = 0.4 → 102.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [0.4, 0.4, 0.4, 1.0],
      params: [['linear_deadzone', 0.5]],
      dumpName: 'saturate_deadzone_below',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 102, b: 102, a: 255 }, 2);
  });

  it('linear_deadzone squashes values above the threshold', async () => {
    // deadzone = 0.5, x = 1.0 → y = 1.0, excess = 0.5,
    // rolloff_range = 0.5. z = 0.5 + 0.5 * tanh(1) ≈ 0.881 → 225.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [['linear_deadzone', 0.5]],
      dumpName: 'saturate_deadzone_above',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 225, g: 225, b: 225, a: 255 }, 3);
  });

  it('asymm > 0 sharpens the rolloff (limit pulled closer to 1)', async () => {
    // asymm=1: steepness=2. x=1 → tanh(2) ≈ 0.964 → 246.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [['asymm', 1.0]],
      dumpName: 'saturate_asymm_pos',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 246, g: 246, b: 246, a: 255 }, 3);
  });

  it('asymm < 0 softens the rolloff (output below tanh)', async () => {
    // asymm=-1: steepness=0.5. x=1 → tanh(0.5) ≈ 0.462 → 118.
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [['asymm', -1.0]],
      dumpName: 'saturate_asymm_neg',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 118, g: 118, b: 118, a: 255 }, 3);
  });

  it('alpha passes through untouched', async () => {
    const frame = await runGpuEffectTest({
      module: 'saturate.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 0.5],
      params: [['prescale', 2.0]],
      dumpName: 'saturate_alpha_passthrough',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ a: 128 }, 2);
  });
});
