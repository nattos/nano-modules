import { describe, it, expect } from 'vitest';
import { traceBarrierKeys } from './engine-trace-barriers';
import type { TracePoint } from './engine-types';

const chainEntry = (
  id: string, chainIdx: number, side: 'input' | 'output',
  sketchId = 'arr-composite', colIdx = 0,
): TracePoint => ({ id, target: { type: 'chain_entry', sketchId, colIdx, chainIdx, side } });

describe('traceBarrierKeys (fusion barrier derivation)', () => {
  // THE invariant we care about most: with nothing traced (the steady state, no
  // preview cards mounted), the planner must see zero barriers so chains fuse fully.
  it('returns an empty set when no trace points are active', () => {
    expect(traceBarrierKeys([]).size).toBe(0);
  });

  it('ignores non-chain_entry trace points (no barriers from output/plugin monitors)', () => {
    const tps: TracePoint[] = [
      { id: 'a', target: { type: 'sketch_output', sketchId: 'arr-composite' } },
      { id: 'b', target: { type: 'plugin_output', pluginKey: 'k' } },
    ];
    expect(traceBarrierKeys(tps).size).toBe(0);
  });

  // An OUTPUT preview barriers the entry itself (ends its group there → its output
  // materialises). This is the pre-existing behaviour and must be preserved.
  it('barriers the entry itself for an OUTPUT-side trace', () => {
    const keys = traceBarrierKeys([chainEntry('o', 3, 'output')]);
    expect([...keys]).toEqual(['arr-composite/0/3']);
  });

  // An INPUT preview barriers the PREDECESSOR (so its output — this entry's input —
  // materialises). This is the input-trace fix.
  it('barriers the predecessor (chainIdx-1) for an INPUT-side trace', () => {
    const keys = traceBarrierKeys([chainEntry('i', 3, 'input')]);
    expect([...keys]).toEqual(['arr-composite/0/2']);
  });

  // chainIdx 0 has no predecessor: an input trace there must add NO barrier (its
  // input is the chain's external/injected input, never a fused intermediate).
  it('adds no barrier for an INPUT-side trace on chainIdx 0', () => {
    expect(traceBarrierKeys([chainEntry('i0', 0, 'input')]).size).toBe(0);
  });

  it('keys are scoped by sketchId + colIdx', () => {
    const keys = traceBarrierKeys([
      chainEntry('a', 2, 'output', 'arr-composite', 0),
      chainEntry('b', 2, 'output', 'other', 1),
    ]);
    expect(keys.has('arr-composite/0/2')).toBe(true);
    expect(keys.has('other/1/2')).toBe(true);
    expect(keys.size).toBe(2);
  });

  // Input + output traces on the SAME entry barrier both it and its predecessor
  // (the entry runs as its own single-entry group → input AND output materialise).
  it('barriers both N-1 and N when an entry has input AND output previews', () => {
    const keys = traceBarrierKeys([chainEntry('i', 3, 'input'), chainEntry('o', 3, 'output')]);
    expect([...keys].sort()).toEqual(['arr-composite/0/2', 'arr-composite/0/3']);
  });
});
