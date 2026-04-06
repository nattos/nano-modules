/**
 * Unit tests for the val handle-based value container.
 *
 * Tests the web-side (TypeScript) implementation of the val host functions
 * by loading a small test WASM module that exercises the val API.
 *
 * Since we can't easily load WASM in vitest (no GPU, no fetch), we test
 * the val implementation directly by constructing the same closure used
 * in wasm-host.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Recreate the val host implementation (same logic as in wasm-host.ts)
function createValHost() {
  const values = new Map<number, any>();
  let nextHandle = 1;
  const alloc = (v: any): number => { const h = nextHandle++; values.set(h, v); return h; };
  const getVal = (h: number): any => values.get(h);

  return {
    alloc,
    getVal,
    values,

    // Host functions (matching the val import module)
    null: () => alloc(null),
    bool: (v: number) => alloc(v !== 0),
    number: (v: number) => alloc(v),
    string: (s: string) => alloc(s),
    array: () => alloc([]),
    object: () => alloc({}),
    type_of: (h: number) => {
      const v = getVal(h);
      if (v === null || v === undefined) return 0;
      if (typeof v === 'boolean') return 1;
      if (typeof v === 'number') return 2;
      if (typeof v === 'string') return 3;
      if (Array.isArray(v)) return 4;
      if (typeof v === 'object') return 5;
      return 0;
    },
    as_number: (h: number) => { const v = getVal(h); return typeof v === 'number' ? v : 0; },
    as_bool: (h: number) => { const v = getVal(h); return v ? 1 : 0; },
    as_string: (h: number) => { const v = getVal(h); return typeof v === 'string' ? v : ''; },
    get: (objH: number, key: string) => {
      const obj = getVal(objH);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
      return key in obj ? alloc(obj[key]) : 0;
    },
    set: (objH: number, key: string, valH: number) => {
      const obj = getVal(objH);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      obj[key] = getVal(valH);
    },
    keys_count: (h: number) => {
      const v = getVal(h);
      return (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).length : 0;
    },
    key_at: (h: number, index: number) => {
      const v = getVal(h);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
      const keys = Object.keys(v);
      return index >= 0 && index < keys.length ? keys[index] : '';
    },
    get_index: (arrH: number, index: number) => {
      const arr = getVal(arrH);
      if (!Array.isArray(arr) || index < 0 || index >= arr.length) return 0;
      return alloc(arr[index]);
    },
    push: (arrH: number, valH: number) => {
      const arr = getVal(arrH);
      if (!Array.isArray(arr)) return;
      arr.push(getVal(valH));
    },
    length: (h: number) => {
      const v = getVal(h);
      return Array.isArray(v) ? v.length : 0;
    },
    release: (h: number) => { values.delete(h); },
    to_json: (h: number) => {
      const v = getVal(h);
      return v === undefined ? '' : JSON.stringify(v);
    },
  };
}

describe('val host functions', () => {
  let val: ReturnType<typeof createValHost>;

  beforeEach(() => {
    val = createValHost();
  });

  describe('construction', () => {
    it('creates null values', () => {
      const h = val.null();
      expect(h).toBeGreaterThan(0);
      expect(val.getVal(h)).toBeNull();
      expect(val.type_of(h)).toBe(0); // Null
    });

    it('creates boolean values', () => {
      const t = val.bool(1);
      const f = val.bool(0);
      expect(val.getVal(t)).toBe(true);
      expect(val.getVal(f)).toBe(false);
      expect(val.type_of(t)).toBe(1); // Bool
      expect(val.type_of(f)).toBe(1);
    });

    it('creates number values', () => {
      const h = val.number(3.14);
      expect(val.getVal(h)).toBeCloseTo(3.14);
      expect(val.type_of(h)).toBe(2); // Number
    });

    it('creates string values', () => {
      const h = val.string('hello');
      expect(val.getVal(h)).toBe('hello');
      expect(val.type_of(h)).toBe(3); // String
    });

    it('creates empty arrays', () => {
      const h = val.array();
      expect(Array.isArray(val.getVal(h))).toBe(true);
      expect(val.length(h)).toBe(0);
      expect(val.type_of(h)).toBe(4); // Array
    });

    it('creates empty objects', () => {
      const h = val.object();
      expect(typeof val.getVal(h)).toBe('object');
      expect(val.keys_count(h)).toBe(0);
      expect(val.type_of(h)).toBe(5); // Object
    });

    it('assigns unique handles', () => {
      const h1 = val.number(1);
      const h2 = val.number(2);
      const h3 = val.number(3);
      expect(h1).not.toBe(h2);
      expect(h2).not.toBe(h3);
    });
  });

  describe('reading', () => {
    it('reads numbers', () => {
      const h = val.number(42.5);
      expect(val.as_number(h)).toBe(42.5);
    });

    it('reads booleans', () => {
      expect(val.as_bool(val.bool(1))).toBe(1);
      expect(val.as_bool(val.bool(0))).toBe(0);
    });

    it('reads strings', () => {
      const h = val.string('world');
      expect(val.as_string(h)).toBe('world');
    });

    it('returns 0 for wrong type reads', () => {
      const s = val.string('hello');
      expect(val.as_number(s)).toBe(0);

      const n = val.number(42);
      expect(val.as_string(n)).toBe('');
    });

    it('returns 0 for invalid handles', () => {
      expect(val.as_number(9999)).toBe(0);
      expect(val.type_of(9999)).toBe(0);
    });
  });

  describe('object access', () => {
    it('sets and gets properties', () => {
      const obj = val.object();
      val.set(obj, 'x', val.number(10));
      val.set(obj, 'y', val.number(20));

      const xh = val.get(obj, 'x');
      const yh = val.get(obj, 'y');
      expect(val.as_number(xh)).toBe(10);
      expect(val.as_number(yh)).toBe(20);
    });

    it('returns 0 for missing keys', () => {
      const obj = val.object();
      expect(val.get(obj, 'missing')).toBe(0);
    });

    it('counts keys', () => {
      const obj = val.object();
      expect(val.keys_count(obj)).toBe(0);
      val.set(obj, 'a', val.number(1));
      val.set(obj, 'b', val.number(2));
      expect(val.keys_count(obj)).toBe(2);
    });

    it('iterates keys', () => {
      const obj = val.object();
      val.set(obj, 'alpha', val.number(1));
      val.set(obj, 'beta', val.number(2));
      const keys = [];
      for (let i = 0; i < val.keys_count(obj); i++) {
        keys.push(val.key_at(obj, i));
      }
      expect(keys.sort()).toEqual(['alpha', 'beta']);
    });

    it('supports nested objects', () => {
      const inner = val.object();
      val.set(inner, 'value', val.number(99));

      const outer = val.object();
      val.set(outer, 'nested', inner);

      const gotInner = val.get(outer, 'nested');
      const gotValue = val.get(gotInner, 'value');
      expect(val.as_number(gotValue)).toBe(99);
    });

    it('does not crash on non-object get/set', () => {
      const arr = val.array();
      expect(val.get(arr, 'key')).toBe(0);
      val.set(arr, 'key', val.number(1)); // no-op
      expect(val.keys_count(arr)).toBe(0);
    });
  });

  describe('array access', () => {
    it('pushes and reads elements', () => {
      const arr = val.array();
      val.push(arr, val.number(10));
      val.push(arr, val.number(20));
      val.push(arr, val.number(30));

      expect(val.length(arr)).toBe(3);
      expect(val.as_number(val.get_index(arr, 0))).toBe(10);
      expect(val.as_number(val.get_index(arr, 1))).toBe(20);
      expect(val.as_number(val.get_index(arr, 2))).toBe(30);
    });

    it('returns 0 for out-of-bounds', () => {
      const arr = val.array();
      val.push(arr, val.number(1));
      expect(val.get_index(arr, -1)).toBe(0);
      expect(val.get_index(arr, 1)).toBe(0);
    });

    it('supports mixed types', () => {
      const arr = val.array();
      val.push(arr, val.number(42));
      val.push(arr, val.string('hello'));
      val.push(arr, val.bool(1));
      val.push(arr, val.null());

      expect(val.type_of(val.get_index(arr, 0))).toBe(2); // Number
      expect(val.type_of(val.get_index(arr, 1))).toBe(3); // String
      expect(val.type_of(val.get_index(arr, 2))).toBe(1); // Bool
      expect(val.type_of(val.get_index(arr, 3))).toBe(0); // Null
    });

    it('supports nested arrays', () => {
      const inner = val.array();
      val.push(inner, val.number(1));
      val.push(inner, val.number(2));

      const outer = val.array();
      val.push(outer, inner);
      val.push(outer, val.number(3));

      expect(val.length(outer)).toBe(2);
      const gotInner = val.get_index(outer, 0);
      expect(val.length(gotInner)).toBe(2);
      expect(val.as_number(val.get_index(gotInner, 0))).toBe(1);
    });
  });

  describe('lifecycle', () => {
    it('release frees the handle', () => {
      const h = val.number(42);
      expect(val.values.has(h)).toBe(true);
      val.release(h);
      expect(val.values.has(h)).toBe(false);
      expect(val.as_number(h)).toBe(0); // returns default after release
    });

    it('releasing invalid handle does not crash', () => {
      val.release(9999); // no-op
    });
  });

  describe('serialization', () => {
    it('serializes null', () => {
      expect(val.to_json(val.null())).toBe('null');
    });

    it('serializes primitives', () => {
      expect(val.to_json(val.number(42))).toBe('42');
      expect(val.to_json(val.bool(1))).toBe('true');
      expect(val.to_json(val.bool(0))).toBe('false');
      expect(val.to_json(val.string('hi'))).toBe('"hi"');
    });

    it('serializes arrays', () => {
      const arr = val.array();
      val.push(arr, val.number(1));
      val.push(arr, val.number(2));
      expect(val.to_json(arr)).toBe('[1,2]');
    });

    it('serializes objects', () => {
      const obj = val.object();
      val.set(obj, 'x', val.number(10));
      const json = JSON.parse(val.to_json(obj));
      expect(json.x).toBe(10);
    });

    it('serializes nested structures', () => {
      const obj = val.object();
      val.set(obj, 'name', val.string('test'));
      const arr = val.array();
      val.push(arr, val.number(1));
      val.push(arr, val.number(2));
      val.set(obj, 'items', arr);

      const json = JSON.parse(val.to_json(obj));
      expect(json.name).toBe('test');
      expect(json.items).toEqual([1, 2]);
    });

    it('returns empty string for invalid handle', () => {
      expect(val.to_json(9999)).toBe('');
    });
  });

  describe('complex scenarios', () => {
    it('builds a nanolooper-style state object', () => {
      const state = val.object();
      val.set(state, 'phase', val.number(0.75));
      val.set(state, 'event_count', val.number(4));

      const grid = val.array();
      for (let ch = 0; ch < 4; ch++) {
        const channel = val.array();
        for (let step = 0; step < 3; step++) {
          val.push(channel, val.number(ch * 16 + step));
        }
        val.push(grid, channel);
      }
      val.set(state, 'grid', grid);

      const json = JSON.parse(val.to_json(state));
      expect(json.phase).toBeCloseTo(0.75);
      expect(json.event_count).toBe(4);
      expect(json.grid.length).toBe(4);
      expect(json.grid[0]).toEqual([0, 1, 2]);
      expect(json.grid[3]).toEqual([48, 49, 50]);
    });

    it('builds and reads back a patch-like object', () => {
      const patch = val.object();
      val.set(patch, 'op', val.string('replace'));
      val.set(patch, 'path', val.string('/brightness'));
      val.set(patch, 'value', val.number(0.7));

      expect(val.as_string(val.get(patch, 'op'))).toBe('replace');
      expect(val.as_string(val.get(patch, 'path'))).toBe('/brightness');
      expect(val.as_number(val.get(patch, 'value'))).toBeCloseTo(0.7);
    });
  });
});
