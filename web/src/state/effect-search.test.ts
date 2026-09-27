import { describe, it, expect } from 'vitest';
import { matchScore, searchEffects, storeSearch } from './effect-search';
import type { AvailableEffect } from './types';

const fx = (id: string, name: string, bundle = 'com.nano.core', keywords: string[] = []): AvailableEffect =>
  ({ id, name, description: '', category: '', keywords, bundle });

const ALL = [
  fx('color.tone.brightness_contrast', 'Brightness & Contrast', 'com.nano.core', ['adjust']),
  fx('color.tone.levels', 'Levels'),
  fx('composite.blend', 'Blend'),
  fx('source.noise', 'Noise'),
  fx('source.light.beam', 'Beam', 'com.nano.lights'),
];

describe('effect search', () => {
  it('ranks exact short names ahead of fuzzy matches', () => {
    expect(matchScore('blend', ALL[2])).toBe(0);
    expect(searchEffects(ALL, 'bl').map(e => e.id)[0]).toBe('composite.blend');
    expect(searchEffects(ALL, '').length).toBe(ALL.length);
  });

  it('store: a plain query ranks across everything', () => {
    const r = storeSearch(ALL, 'adjust');
    expect(r.ranked).toBe(true);
    expect(r.effects.map(e => e.id)).toEqual(['color.tone.brightness_contrast']);
  });

  it('store: a path narrows to a folder, and searches inside it', () => {
    const folder = storeSearch(ALL, 'color.');
    expect(folder.ranked).toBe(false);
    expect(folder.effects.map(e => e.id)).toEqual(['color.tone.brightness_contrast', 'color.tone.levels']);
    const inside = storeSearch(ALL, 'color.tone.lev');
    expect(inside.effects.map(e => e.id)).toEqual(['color.tone.levels']);
  });

  it('store: a bundle id is a folder too', () => {
    expect(storeSearch(ALL, 'com.nano.lights.').effects.map(e => e.id)).toEqual(['source.light.beam']);
  });

  it('store: an unknown path falls back to a plain query', () => {
    const r = storeSearch(ALL, 'zz.noise');
    expect(r.ranked).toBe(true);
    expect(r.effects.map(e => e.id)).toEqual([]);
    expect(storeSearch(ALL, 'nope.').effects).toEqual([]);
  });
});
