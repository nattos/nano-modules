import { describe, it, expect } from 'vitest';
import { availableModes, coerceMode } from './product';

describe('product modes', () => {
  it('a plain browser (no product) keeps every mode', () => {
    expect(availableModes(null)).toEqual(['effect-dev', 'live', 'playground']);
    expect(coerceMode('effect-dev', null)).toBe('effect-dev');
  });

  it('Remote Control has no Effect Dev, and lands an inherited one in Remote Control', () => {
    expect(availableModes('remote')).toEqual(['live', 'playground']);
    expect(coerceMode('effect-dev', 'remote')).toBe('live');
    expect(coerceMode('playground', 'remote')).toBe('playground');
    expect(coerceMode('live', 'remote')).toBe('live');
  });
});
