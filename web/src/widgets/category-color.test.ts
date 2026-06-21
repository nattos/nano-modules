import { describe, it, expect } from 'vitest';
import { effectDomain, categoryColor, isCategoryDomain, CATEGORY_DOMAINS } from './category-color';

describe('category-color', () => {
  it('extracts the domain (first path segment) from an effect id', () => {
    expect(effectDomain('source.light.chroma_wave')).toBe('source');
    expect(effectDomain('color.tone.curve')).toBe('color');
    expect(effectDomain('composite.blend')).toBe('composite');
    // No dot → the whole string is the domain.
    expect(effectDomain('weird')).toBe('weird');
  });

  it('maps known domains to their CSS var, unknowns to a neutral fallback', () => {
    for (const d of CATEGORY_DOMAINS) {
      expect(categoryColor(d)).toBe(`var(--app-cat-${d})`);
      expect(isCategoryDomain(d)).toBe(true);
    }
    expect(isCategoryDomain('bogus')).toBe(false);
    expect(categoryColor('bogus')).toBe('var(--app-text-color2, #B0B0B0)');
  });
});
