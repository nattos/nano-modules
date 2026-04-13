import { describe, it, expect } from 'vitest';
import { stripGpuFields } from './wasm-host';

describe('stripGpuFields', () => {
  it('zeroes top-level GPU array handles', () => {
    const schema = {
      positions: { type: 'array', gpu: true, elementType: { type: 'float' } },
      count: { type: 'int' },
    };
    const state = { positions: 42, count: 7 };
    expect(stripGpuFields(state, schema)).toEqual({ positions: 0, count: 7 });
  });

  it('leaves non-GPU arrays untouched', () => {
    const schema = {
      ids: { type: 'array', elementType: { type: 'int' } },
    };
    const state = { ids: [1, 2, 3] };
    expect(stripGpuFields(state, schema)).toEqual({ ids: [1, 2, 3] });
  });

  it('recurses into object subtrees', () => {
    const schema = {
      out: {
        type: 'object',
        fields: {
          buf: { type: 'array', gpu: true },
          meta: { type: 'object', fields: { tag: { type: 'string' } } },
        },
      },
    };
    const state = { out: { buf: 99, meta: { tag: 'v1' } } };
    expect(stripGpuFields(state, schema)).toEqual({
      out: { buf: 0, meta: { tag: 'v1' } },
    });
  });

  it('handles missing fields gracefully', () => {
    const schema = { a: { type: 'float' }, b: { type: 'array', gpu: true } };
    const state = { a: 1 };
    expect(stripGpuFields(state, schema)).toEqual({ a: 1 });
  });

  it('returns state as-is for non-object inputs', () => {
    expect(stripGpuFields(5, { a: { type: 'float' } })).toBe(5);
    expect(stripGpuFields(null, { a: { type: 'float' } })).toBe(null);
  });
});
