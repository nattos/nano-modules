import { describe, it, expect } from 'vitest';
import { LENS_PRESETS, lensPresetEdit } from './lens-inspector';

/**
 * The preset dicts are a hand-transcription of the prototype's presets.py (LOOKS)
 * into the effect's NORMALIZED schema ids/ranges — the error-prone part. These
 * lock the mapping: enum indices, the DIST_SCALE(0.30) / TCA_SCALE(0.03) divides,
 * the cats_eye clamp, and the rgb-array colour override.
 */
describe('lensPresetEdit', () => {
  it('Custom (0) applies only the preset field — no character overrides', () => {
    expect(lensPresetEdit(0)).toEqual({ preset: 0 });
  });

  it('always includes the preset value so the choice serializes', () => {
    for (const v of [0, 1, 2, 3, 4, 5]) {
      expect(lensPresetEdit(v).preset).toBe(v);
    }
  });

  it('unknown preset ids degrade to just the preset field', () => {
    expect(lensPresetEdit(99)).toEqual({ preset: 99 });
  });

  it('coating strings map to enum indices (smc=0, single=1)', () => {
    expect(LENS_PRESETS[1].coating).toBe(0);   // modern_prime → SMC
    expect(LENS_PRESETS[2].coating).toBe(1);   // vintage → Single
    expect(LENS_PRESETS[4].coating).toBe(1);   // dreamy → Single
    expect(LENS_PRESETS[5].coating).toBe(0);   // clinical → SMC
  });

  it('raw distortion / tca are pre-divided by DIST_SCALE / TCA_SCALE', () => {
    // vintage: distortion -0.05 / 0.30 ≈ -0.167 ; tca 0.013 / 0.03 ≈ 0.433
    expect(LENS_PRESETS[2].distortion as number).toBeCloseTo(-0.167, 2);
    expect(LENS_PRESETS[2].tca as number).toBeCloseTo(0.433, 2);
    // anamorphic: tca 0.006 / 0.03 = 0.2
    expect(LENS_PRESETS[3].tca as number).toBeCloseTo(0.2, 3);
  });

  it('cats_eye is clamped to the [0,1] slider (vintage raw 1.15)', () => {
    expect(LENS_PRESETS[2].cats_eye as number).toBeLessThanOrEqual(1.0);
    expect(LENS_PRESETS[2].cats_eye).toBe(1.0);
  });

  it('anamorphic overrides sun_color as an rgb array', () => {
    expect(LENS_PRESETS[3].sun_color).toEqual([0.5, 0.7, 1.0]);
  });

  it('every override value is a number or a numeric array', () => {
    for (const [, dict] of Object.entries(LENS_PRESETS)) {
      for (const [, v] of Object.entries(dict)) {
        const ok = typeof v === 'number' || (Array.isArray(v) && v.every((n) => typeof n === 'number'));
        expect(ok).toBe(true);
      }
    }
  });
});
