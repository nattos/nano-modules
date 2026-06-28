import { describe, it, expect } from 'vitest';
import { seedTestPlugins } from './test-plugins';
import { generatorFingerprint, generatorIsTimeIndependent, isGeneratorClip } from './generator-fingerprint';

// The registry derives from store.enginePlugins (empty offline) — seed the fakes.
seedTestPlugins();

const dev = (moduleType: string, state: Record<string, unknown> = {}) =>
  ({ id: moduleType, moduleType, name: moduleType, capabilities: [], state });
const clip = (devices: ReturnType<typeof dev>[]) =>
  ({ id: 'c', startBeat: 0, lengthBeat: 4, source: undefined, sketch: { devices } } as any);

describe('generatorFingerprint', () => {
  it('is null when the clip has no generator device', () => {
    expect(generatorFingerprint(clip([dev('color.hsl')]))).toBeNull();
  });

  it('stays stable across a sub-bucket nudge but flips across a bucket boundary', () => {
    // noise.scale range [0,1] / 64 buckets ⇒ step ≈ 0.0156.
    const a = generatorFingerprint(clip([dev('source.noise', { scale: 0.5 })]));
    const nudge = generatorFingerprint(clip([dev('source.noise', { scale: 0.505 })])); // < ½ bucket
    const big = generatorFingerprint(clip([dev('source.noise', { scale: 0.7 })]));
    expect(a).toBe(nudge);
    expect(a).not.toBe(big);
  });

  it('includes moduleType and chained effects', () => {
    const gen = generatorFingerprint(clip([dev('source.noise')]));
    const genFx = generatorFingerprint(clip([dev('source.noise'), dev('color.hsl', { hue_shift: 0.5 })]));
    expect(gen).not.toBe(genFx);
  });

  it('buckets nested vec state (a solid colour) with the same tolerance', () => {
    const a = generatorFingerprint(clip([dev('source.solid_color', { color: [0.5, 0.5, 0.5] })]));
    const nudge = generatorFingerprint(clip([dev('source.solid_color', { color: [0.5, 0.5, 0.505] })]));
    const big = generatorFingerprint(clip([dev('source.solid_color', { color: [0.9, 0.1, 0.1] })]));
    expect(a).toBe(nudge);
    expect(a).not.toBe(big);
  });
});

describe('generatorIsTimeIndependent', () => {
  it('true for solid_color (+ static fx), false when a time-varying device is present', () => {
    expect(generatorIsTimeIndependent(clip([dev('source.solid_color'), dev('color.hsl')]))).toBe(true);
    expect(generatorIsTimeIndependent(clip([dev('source.noise')]))).toBe(false);
    expect(generatorIsTimeIndependent(clip([dev('source.solid_color'), dev('source.noise')]))).toBe(false);
  });
});

describe('isGeneratorClip', () => {
  it('true for a generator device; false for effect-only or media-backed', () => {
    expect(isGeneratorClip(clip([dev('source.noise')]))).toBe(true);
    expect(isGeneratorClip(clip([dev('color.hsl')]))).toBe(false);
    const media = clip([dev('source.video.file')]);
    media.source = { url: 'file://x.mp4' };
    expect(isGeneratorClip(media)).toBe(false);
  });
});
