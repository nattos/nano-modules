// Per-sketch output format: the TS twin of the C++ parser
// (sketch_executor.cpp parseOutputFormat) plus schema round-trip and the
// fused-WGSL output-format parameter.

import { describe, it, expect } from 'vitest';
import {
  normalizeSketchChains, resolveInternalResolution, sketchBitDepth,
  isDefaultOutputFormat, sanitizeOutputFormat, type Sketch, type SketchOutputFormat,
} from './sketch-types';
import { composeWgsl, type FusionStage } from './fusion-dispatcher';

describe('resolveInternalResolution (lock-step with C++ parseOutputFormat)', () => {
  const at = (fmt: SketchOutputFormat | undefined, w = 1920, h = 1080) =>
    resolveInternalResolution(fmt, w, h);

  it('absent / empty / malformed → host size', () => {
    expect(at(undefined)).toEqual({ width: 1920, height: 1080 });
    expect(at({})).toEqual({ width: 1920, height: 1080 });
    expect(at({ resolution: { mode: 'multiplier', scale: NaN } }))
      .toEqual({ width: 1920, height: 1080 });
    expect(at({ resolution: { mode: 'fixed', width: 0, height: 0 } }))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('multiplier presets', () => {
    expect(at({ resolution: { mode: 'multiplier', scale: 0.5 } }))
      .toEqual({ width: 960, height: 540 });
    expect(at({ resolution: { mode: 'multiplier', scale: 2 } }))
      .toEqual({ width: 3840, height: 2160 });
    expect(at({ resolution: { mode: 'multiplier', scale: 1 } }))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('multiplier rounding matches lround (half away from zero)', () => {
    // 64 * 0.1 = 6.4 → 6 → floor-clamps to 8 (same as the C++ test).
    expect(at({ resolution: { mode: 'multiplier', scale: 0.01 } }, 64, 64))
      .toEqual({ width: 8, height: 8 });
    // 25 * 0.5 = 12.5 → rounds to 13.
    expect(at({ resolution: { mode: 'multiplier', scale: 0.5 } }, 25, 25))
      .toEqual({ width: 13, height: 13 });
  });

  it('scale clamps to [0.1, 8]', () => {
    expect(at({ resolution: { mode: 'multiplier', scale: 100 } }, 64, 64))
      .toEqual({ width: 512, height: 512 });   // clamped to 8x
    expect(at({ resolution: { mode: 'multiplier', scale: 0.0001 } }, 1000, 1000))
      .toEqual({ width: 100, height: 100 });   // clamped to 0.1x
  });

  it('fixed mode + dimension clamps [8, 8192]', () => {
    expect(at({ resolution: { mode: 'fixed', width: 1280, height: 720 } }))
      .toEqual({ width: 1280, height: 720 });
    expect(at({ resolution: { mode: 'fixed', width: 100000, height: 16 } }))
      .toEqual({ width: 8192, height: 16 });
    expect(at({ resolution: { mode: 'fixed', width: 2, height: 2 } }))
      .toEqual({ width: 8, height: 8 });
  });
});

describe('sketchBitDepth / isDefaultOutputFormat', () => {
  it('bit depth defaults to 8', () => {
    expect(sketchBitDepth({ anchor: null })).toBe(8);
    expect(sketchBitDepth({ anchor: null, outputFormat: { bitDepth: 16 } })).toBe(16);
    expect(sketchBitDepth({ anchor: null, outputFormat: {} })).toBe(8);
  });

  it('default detection (drives key deletion in the UI)', () => {
    expect(isDefaultOutputFormat(undefined)).toBe(true);
    expect(isDefaultOutputFormat({})).toBe(true);
    expect(isDefaultOutputFormat({ bitDepth: 8 })).toBe(true);
    expect(isDefaultOutputFormat({ resolution: { mode: 'multiplier', scale: 1 } })).toBe(true);
    expect(isDefaultOutputFormat({ bitDepth: 16 })).toBe(false);
    expect(isDefaultOutputFormat({ resolution: { mode: 'multiplier', scale: 0.5 } })).toBe(false);
    expect(isDefaultOutputFormat({ resolution: { mode: 'fixed', width: 1920, height: 1080 } })).toBe(false);
  });
});

describe('sanitizeOutputFormat (guards against non-finite → JSON null → native abort)', () => {
  it('drops non-finite / non-positive multiplier scale', () => {
    // These previously serialized to `null` and aborted the WASM executor.
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: NaN } })).toBeUndefined();
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: Infinity } })).toBeUndefined();
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: -5 } })).toBeUndefined();
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: 0 } })).toBeUndefined();
    // scale 1 is the identity default → also collapses to undefined.
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: 1 } })).toBeUndefined();
  });

  it('drops fixed resolution with non-finite / non-positive dimensions', () => {
    expect(sanitizeOutputFormat({ resolution: { mode: 'fixed', width: NaN, height: 720 } })).toBeUndefined();
    expect(sanitizeOutputFormat({ resolution: { mode: 'fixed', width: 1280, height: 0 } })).toBeUndefined();
    expect(sanitizeOutputFormat({ resolution: { mode: 'fixed', width: -100, height: 720 } })).toBeUndefined();
  });

  it('preserves valid overrides and bit depth', () => {
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: 0.5 } }))
      .toEqual({ resolution: { mode: 'multiplier', scale: 0.5 } });
    expect(sanitizeOutputFormat({ resolution: { mode: 'fixed', width: 1280, height: 720 } }))
      .toEqual({ resolution: { mode: 'fixed', width: 1280, height: 720 } });
    // A bad scale is dropped but a valid 16F depth is kept.
    expect(sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: NaN }, bitDepth: 16 }))
      .toEqual({ bitDepth: 16 });
  });

  it('the sanitized output never JSON-stringifies a null number', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const clean = sanitizeOutputFormat({ resolution: { mode: 'multiplier', scale: bad }, bitDepth: 16 });
      expect(JSON.stringify(clean)).not.toContain('null');
    }
  });
});

describe('outputFormat schema round-trip', () => {
  it('survives normalizeSketchChains (ingest normalization)', () => {
    const sketch: Sketch = {
      anchor: null,
      chain: [{ type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'a' }],
      instances: { a: { module_type: 'color.tone.brightness_contrast', state: {} } },
      wires: [],
      outputFormat: { resolution: { mode: 'multiplier', scale: 0.5 }, bitDepth: 16 },
    };
    const normalized = normalizeSketchChains(sketch);
    expect(normalized.outputFormat).toEqual(
      { resolution: { mode: 'multiplier', scale: 0.5 }, bitDepth: 16 });
    // And survives a JSON round-trip (project-store persistence).
    const persisted = JSON.parse(JSON.stringify(normalized)) as Sketch;
    expect(persisted.outputFormat).toEqual(normalized.outputFormat);
  });

  it('scrubs a malformed persisted outputFormat on ingest', () => {
    // A prior session may have persisted a NaN scale → JSON null. Ingest must
    // strip it so it never reaches the executor.
    const sketch = {
      anchor: null,
      chain: [{ type: 'module', module_type: 'source.solid_color', instance_key: 'a' }],
      wires: [],
      outputFormat: { resolution: { mode: 'multiplier', scale: null } },
    } as unknown as Sketch;
    const normalized = normalizeSketchChains(sketch);
    expect(normalized.outputFormat).toBeUndefined();
    expect('outputFormat' in normalized).toBe(false);
  });
});

describe('composeWgsl output format', () => {
  const stage: FusionStage = {
    effectId: 'test.effect',
    fusionKind: 1,  // per-pixel mapper
    fragmentWgsl: 'fn fuse_pixel(c: vec4<f32>, uv: vec2<f32>) -> vec4<f32> { return c; }',
    uniformBufferHandle: 0,
  };

  it('defaults to rgba8unorm', () => {
    const wgsl = composeWgsl([stage], []);
    expect(wgsl).toContain('var outputTex: texture_storage_2d<rgba8unorm, write>');
  });

  it('bakes the requested output format; trace textures stay rgba8unorm', () => {
    const wgsl = composeWgsl([stage, stage], [0], 'rgba16float');
    expect(wgsl).toContain('var outputTex: texture_storage_2d<rgba16float, write>');
    expect(wgsl).toContain('traceTex_0: texture_storage_2d<rgba8unorm, write>');
  });
});
