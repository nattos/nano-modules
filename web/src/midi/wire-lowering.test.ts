import { describe, expect, it } from 'vitest';
import type { Sketch } from '../sketch-types';
import { buildExternalScalars, collectDeviceWireRefs } from './wire-lowering';

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

describe('collectDeviceWireRefs', () => {
  it('collects midi endpoints across sketches, ignoring module wires', () => {
    const refs = collectDeviceWireRefs(sketches);
    expect([...refs.keys()].sort()).toEqual(['dev-1', 'dev-2']);
    expect([...refs.get('dev-1')!].sort()).toEqual(['b0/e05/press', 'b0/e05/turn']);
  });
});

describe('buildExternalScalars', () => {
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
