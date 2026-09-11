import { describe, expect, it } from 'vitest';
import type { Sketch } from '../sketch-types';
import {
  buildExternalScalars, collectAliasEdges, collectDeviceWireRefs, isAliasWire,
} from './wire-lowering';

const sketches = {
  a: {
    anchor: null,
    wires: [
      { id: 'w1', src: { instanceKey: 'midi:dev-1', field: 'b0/e05/turn' }, dest: { instanceKey: 'bc', field: 'brightness' } },
      { id: 'w2', src: { instanceKey: 'midi:dev-1', field: 'b0/e05/press' }, dest: { instanceKey: 'bc', field: '__enable__' } },
      { id: 'w3', src: { instanceKey: 'lfo', field: 'output' }, dest: { instanceKey: 'bc', field: 'contrast' } },
    ],
  } as unknown as Sketch,
  b: {
    anchor: null,
    wires: [
      { id: 'w4', src: { instanceKey: 'midi:dev-2', field: 'b1/e00/turn' }, dest: { instanceKey: 'x', field: 'amount' } },
    ],
  } as unknown as Sketch,
  empty: { anchor: null } as unknown as Sketch,
};

/** Two control aliases plus a self-alias and a duplicate of the first. */
const aliased = {
  a: {
    anchor: null,
    wires: [
      { id: 'w1', src: { instanceKey: 'midi:dev-1', field: 'b0/e05/turn' }, dest: { instanceKey: 'bc', field: 'brightness' } },
      { id: 'a1', src: { instanceKey: 'midi:dev-1', field: 'b0/e05/turn' }, dest: { instanceKey: 'midi:dev-2', field: 'b0/e05/turn' } },
      { id: 'a2', src: { instanceKey: 'midi:dev-2', field: 'b0/e05/turn' }, dest: { instanceKey: 'midi:dev-1', field: 'b0/e05/turn' } },
      { id: 'a3', src: { instanceKey: 'midi:dev-1', field: 'b1/e00/press' }, dest: { instanceKey: 'midi:dev-1', field: 'b1/e00/press' } },
    ],
  } as unknown as Sketch,
  b: {
    anchor: null,
    wires: [
      { id: 'a4', src: { instanceKey: 'midi:dev-3', field: 'b0/e00/turn' }, dest: { instanceKey: 'midi:dev-1', field: 'b0/e01/turn' } },
    ],
  } as unknown as Sketch,
};

describe('collectDeviceWireRefs', () => {
  it('collects midi endpoints across sketches, ignoring module wires', () => {
    const refs = collectDeviceWireRefs(sketches);
    expect([...refs.keys()].sort()).toEqual(['dev-1', 'dev-2']);
    expect([...refs.get('dev-1')!].sort()).toEqual(['b0/e05/press', 'b0/e05/turn']);
  });
});

describe('collectAliasEdges', () => {
  it('dedupes mirrored pairs, drops self-aliases, and spans sketches', () => {
    const edges = collectAliasEdges(aliased);
    expect(edges).toEqual([
      { a: { deviceId: 'dev-1', field: 'b0/e05/turn' }, b: { deviceId: 'dev-2', field: 'b0/e05/turn' } },
      { a: { deviceId: 'dev-3', field: 'b0/e00/turn' }, b: { deviceId: 'dev-1', field: 'b0/e01/turn' } },
    ]);
  });

  it('finds nothing in a document of plain modulation wires', () => {
    expect(collectAliasEdges(sketches)).toEqual([]);
  });
});

describe('isAliasWire', () => {
  it('needs BOTH ends to be device endpoints', () => {
    expect(isAliasWire(aliased.a.wires![1])).toBe(true);
    expect(isAliasWire(aliased.a.wires![0])).toBe(false);
    expect(isAliasWire(sketches.a.wires![2])).toBe(false);
  });
});

describe('buildExternalScalars', () => {
  it('ignores alias wires — they reference no sketch field', () => {
    // dev-2/dev-3 appear ONLY in aliases, so no rail is ever built for them.
    const refs = collectDeviceWireRefs(aliased);
    expect([...refs.keys()]).toEqual(['dev-1']);
    expect([...refs.get('dev-1')!]).toEqual(['b0/e05/turn']);
  });

  it('emits only wired endpoints with known values, sorted + stable', () => {
    const values = (id: string) =>
      id === 'dev-1'
        ? new Map([['b0/e05/turn', 0.5], ['b3/e09/turn', 0.9] /* unwired — excluded */])
        : new Map<string, number>();   // dev-2 never touched → dormant
    const json = buildExternalScalars(sketches, values);
    expect(JSON.parse(json)).toEqual({ 'midi:dev-1': { 'b0/e05/turn': 0.5 } });
    expect(buildExternalScalars(sketches, values)).toBe(json);   // deterministic
  });

  it('returns {} when nothing is wired or valued', () => {
    expect(buildExternalScalars({ empty: sketches.empty }, () => new Map())).toBe('{}');
  });
});
