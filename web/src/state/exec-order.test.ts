/**
 * The merged execution order (see state/exec-order.ts) and the schema-level
 * repair rule it is replayed through (sketch-types.repairExecOrder).
 *
 * Most cases are driven from web/test/fixtures/exec-order-cases.json, which
 * native/tests/test_exec_order.cpp reads too — that shared file is what keeps
 * the one TS/C++ duplicated rule from drifting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeExecOrder, execPositions, wireIsDelayed } from './exec-order';
import {
  type ChainEntry, type Sketch,
  execOrderIsChainOrder, normalizeSketchChains, repairExecOrder, sketchChain,
} from '../sketch-types';

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../test/fixtures/exec-order-cases.json', import.meta.url)),
  'utf-8')) as {
    cases: Array<{
      name: string;
      chain: Array<{ key: string; canvas: boolean }>;
      wires: Array<{ id: string; src: string; dest: string }>;
      expectedOrder: string[];
      expectedDelayed: string[];
      expectOmitted: boolean;
    }>;
    repairCases: Array<{ name: string; chain: string[]; stored: unknown; expected: string[] }>;
  };

let placed = 0;
function entry(key: string, canvas: boolean): ChainEntry {
  const e: ChainEntry = { type: 'module', module_type: 'debug.noop', instance_key: key };
  if (canvas) e.canvas = { x: 40 * (placed % 4), y: 60 * placed++ };
  return e;
}

function sketchOf(c: (typeof FIXTURE)['cases'][number]): Sketch {
  return {
    anchor: null,
    chain: c.chain.map(e => entry(e.key, e.canvas)),
    wires: c.wires.map(w => ({
      id: w.id,
      src: { instanceKey: w.src, field: 'out' },
      dest: { instanceKey: w.dest, field: 'in' },
    })),
    instances: {},
  };
}

const keys = (chain: ChainEntry[]) => chain.map(e => e.instance_key);

describe('computeExecOrder (shared fixture)', () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const sketch = sketchOf(c);
      const order = computeExecOrder(sketch);
      expect(order).toEqual(c.expectedOrder);

      // The order is omitted from the document exactly when it is chain order.
      expect(execOrderIsChainOrder(sketchChain(sketch), order)).toBe(c.expectOmitted);

      // Causality is read back from the STORED order, the same way the executor
      // and <taps-overlay> read it.
      const pos = execPositions({ ...sketch, execOrder: order });
      const delayed = (sketch.wires ?? [])
        .filter(w => wireIsDelayed(pos, w.src.instanceKey, w.dest.instanceKey))
        .map(w => w.id);
      expect(delayed).toEqual(c.expectedDelayed);
    });
  }

  it('is idempotent — re-sorting an ordered sketch changes nothing', () => {
    for (const c of FIXTURE.cases) {
      const sketch = sketchOf(c);
      const once = computeExecOrder(sketch);
      expect(computeExecOrder({ ...sketch, execOrder: once })).toEqual(once);
    }
  });

  it('never reorders the linear list, whatever the wires say', () => {
    for (const c of FIXTURE.cases) {
      const sketch = sketchOf(c);
      const order = computeExecOrder(sketch);
      const linear = keys(sketchChain(sketch).filter(e => !e.canvas));
      expect(order.filter(k => linear.includes(k))).toEqual(linear);
    }
  });

  it('emits every chain entry exactly once', () => {
    for (const c of FIXTURE.cases) {
      const sketch = sketchOf(c);
      const order = computeExecOrder(sketch);
      expect([...order].sort()).toEqual([...keys(sketchChain(sketch))].sort());
    }
  });
});

describe('repairExecOrder (shared fixture)', () => {
  for (const c of FIXTURE.repairCases) {
    it(c.name, () => {
      const chain = c.chain.map(k => entry(k, false));
      expect(repairExecOrder(chain, c.stored)).toEqual(c.expected);
    });
  }

  it('rejects non-string and foreign entries', () => {
    const chain = ['a', 'b'].map(k => entry(k, false));
    expect(repairExecOrder(chain, [1, null, 'b', {}, 'nope'])).toEqual(['b', 'a']);
    expect(repairExecOrder(chain, 'not-an-array')).toEqual(['a', 'b']);
  });
});

describe('normalizeSketchChains — canvas partition', () => {
  const mk = (spec: Array<[string, boolean]>): Sketch => ({
    anchor: null, chain: spec.map(([k, c]) => entry(k, c)), wires: [], instances: {},
  });

  it('moves canvas entries to the tail, preserving relative order', () => {
    const out = normalizeSketchChains(
      mk([['a', false], ['p', true], ['b', false], ['q', true], ['c', false]]));
    expect(keys(sketchChain(out))).toEqual(['a', 'b', 'c', 'p', 'q']);
  });

  it('is idempotent', () => {
    const once = normalizeSketchChains(mk([['a', false], ['p', true], ['b', false]]));
    const twice = normalizeSketchChains(once);
    expect(JSON.stringify(twice)).toEqual(JSON.stringify(once));
  });

  it('leaves a canvas-free sketch byte-identical', () => {
    const before = mk([['a', false], ['b', false]]);
    const json = JSON.stringify(before);
    expect(JSON.stringify(normalizeSketchChains(before))).toEqual(json);
  });

  it('omits execOrder when it is just chain order', () => {
    const out = normalizeSketchChains(
      { ...mk([['a', false], ['b', false]]), execOrder: ['a', 'b'] });
    expect('execOrder' in out).toBe(false);
  });

  it('repairs a stale execOrder instead of trusting it', () => {
    const out = normalizeSketchChains(
      { ...mk([['a', false], ['b', false], ['p', true]]), execOrder: ['p', 'gone', 'a'] });
    expect(out.execOrder).toEqual(['p', 'a', 'b']);
  });

  it('demotes an entry whose placement is malformed', () => {
    const s = mk([['a', false], ['p', true]]);
    (sketchChain(s)[1] as any).canvas = { x: Number.NaN, y: 0 };
    const out = normalizeSketchChains(s);
    expect(sketchChain(out)[1].canvas).toBeUndefined();
  });

  it('drops a bad width but keeps a usable position', () => {
    const s = mk([['p', true]]);
    (sketchChain(s)[0] as any).canvas = { x: 10, y: 20, w: Number.POSITIVE_INFINITY };
    expect(sketchChain(normalizeSketchChains(s))[0].canvas).toEqual({ x: 10, y: 20 });
  });

  it('keeps linear chain indices stable across canvas edits', () => {
    const base = normalizeSketchChains(mk([['a', false], ['b', false], ['c', false]]));
    const withCanvas = normalizeSketchChains(
      { ...base, chain: [...sketchChain(base), entry('p', true)] });
    for (let i = 0; i < 3; i++) {
      expect(sketchChain(withCanvas)[i].instance_key).toEqual(sketchChain(base)[i].instance_key);
    }
  });
});
