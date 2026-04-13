import { describe, it, expect } from 'vitest';
import { isRailCompatible, railCompatError } from './schema-compat';

describe('schema-compat', () => {
  it('accepts identical leaf nodes', () => {
    expect(isRailCompatible({ type: 'float' }, { type: 'float' })).toBe(true);
    expect(isRailCompatible({ type: 'texture' }, { type: 'texture' })).toBe(true);
  });

  it('rejects leaf type mismatch', () => {
    expect(isRailCompatible({ type: 'float' }, { type: 'int' })).toBe(false);
  });

  it('walks nested object fields', () => {
    const s = {
      type: 'object',
      fields: {
        count: { type: 'int' },
        pos: { type: 'object', fields: { x: { type: 'float' }, y: { type: 'float' } } },
      },
    };
    expect(isRailCompatible(s, s)).toBe(true);
  });

  it('catches missing field on writer', () => {
    const w = { type: 'object', fields: { a: { type: 'float' } } };
    const r = { type: 'object', fields: { a: { type: 'float' }, b: { type: 'int' } } };
    expect(isRailCompatible(w, r)).toBe(false);
    expect(railCompatError(w, r)).toMatch(/missing on writer/);
  });

  it('requires matching gpu flag on arrays', () => {
    const w = { type: 'array', gpu: true, elementType: { type: 'float' } };
    const r = { type: 'array', gpu: false, elementType: { type: 'float' } };
    expect(isRailCompatible(w, r)).toBe(false);
    expect(railCompatError(w, r)).toMatch(/gpu flag/);
  });

  it('accepts matching GPU arrays', () => {
    const w = { type: 'array', gpu: true, elementType: { type: 'float' } };
    expect(isRailCompatible(w, w)).toBe(true);
  });

  it('allows extra writer fields when opted in', () => {
    const w = { type: 'object', fields: { a: { type: 'float' }, extra: { type: 'int' } } };
    const r = { type: 'object', fields: { a: { type: 'float' } } };
    expect(isRailCompatible(w, r)).toBe(false);
    expect(isRailCompatible(w, r, { allowExtraWriterFields: true })).toBe(true);
  });

  it('recurses into array element types', () => {
    const w = {
      type: 'array',
      elementType: { type: 'object', fields: { x: { type: 'float' } } },
    };
    const r = {
      type: 'array',
      elementType: { type: 'object', fields: { x: { type: 'int' } } },
    };
    expect(isRailCompatible(w, r)).toBe(false);
  });
});
