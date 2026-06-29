import { describe, it, expect } from 'vitest';
import {
  reconcileDevices,
  aggregateField,
  reconcileWires,
  reconcileRails,
  clipInsertIndex,
  buildMultiEditModel,
} from './multi-edit';
import type { Clip, Device } from '../model/composition';
import type { Wire } from '../../../sketch-types';

// ── tiny fixtures (the pure core only reads id / sketch / exports / reads) ──
function dev(id: string, moduleType: string, state?: Record<string, unknown>): Device {
  return { id, moduleType, name: moduleType, capabilities: [], state };
}
function clip(id: string, devices: Device[], wires: Wire[] = [], extra: Partial<Clip> = {}): Clip {
  return { id, sketch: { devices, wires }, ...extra } as Clip;
}
function wire(id: string, srcDev: string, srcField: string, destDev: string, destField: string): Wire {
  return { id, src: { instanceKey: srcDev, field: srcField }, dest: { instanceKey: destDev, field: destField } };
}

describe('reconcileDevices', () => {
  it('identical chains → all common, no ragged', () => {
    const a = clip('a', [dev('a1', 'color.sat'), dev('a2', 'blur.gauss')]);
    const b = clip('b', [dev('b1', 'color.sat'), dev('b2', 'blur.gauss')]);
    const r = reconcileDevices([a, b]);
    expect(r.common.map((c) => c.moduleType)).toEqual(['color.sat', 'blur.gauss']);
    expect(r.common[0].repId).toBe('a1');
    expect(r.common[0].idByClip.get('b')).toBe('b1');
    expect(r.ragged).toHaveLength(0);
  });

  it('single clip → everything common', () => {
    const a = clip('a', [dev('a1', 'x'), dev('a2', 'y')]);
    const r = reconcileDevices([a]);
    expect(r.common).toHaveLength(2);
    expect(r.ragged).toHaveLength(0);
  });

  it('an extra middle device in one clip → ragged in the right gap, neighbors common', () => {
    const a = clip('a', [dev('a1', 'sat'), dev('a2', 'out')]);
    const b = clip('b', [dev('b1', 'sat'), dev('b2', 'extra'), dev('b3', 'out')]);
    const r = reconcileDevices([a, b]);
    expect(r.common.map((c) => c.moduleType)).toEqual(['sat', 'out']);
    // gap between common[0] (sat) and common[1] (out) is gapIndex 1.
    expect(r.ragged).toHaveLength(1);
    expect(r.ragged[0].gapIndex).toBe(1);
    expect(r.ragged[0].idsByClip.get('b')).toEqual(['b2']);
    expect(r.ragged[0].count).toBe(1);
  });

  it('template device missing from another clip → ragged for clip[0]', () => {
    const a = clip('a', [dev('a1', 'sat'), dev('a2', 'glow')]);
    const b = clip('b', [dev('b1', 'sat')]);
    const r = reconcileDevices([a, b]);
    expect(r.common.map((c) => c.moduleType)).toEqual(['sat']);
    // a2 'glow' has no match in b → ragged in the final gap (after the lone common).
    const seg = r.ragged.find((s) => s.idsByClip.get('a')?.includes('a2'));
    expect(seg).toBeTruthy();
    expect(seg!.gapIndex).toBe(1);
  });

  it('trailing-only divergence → a single final-gap segment', () => {
    const a = clip('a', [dev('a1', 'sat'), dev('a2', 'tailA')]);
    const b = clip('b', [dev('b1', 'sat'), dev('b2', 'tailB')]);
    const r = reconcileDevices([a, b]);
    expect(r.common.map((c) => c.moduleType)).toEqual(['sat']);
    expect(r.ragged).toHaveLength(1);
    expect(r.ragged[0].gapIndex).toBe(1);
    // both clips contribute their divergent tails to this one gap.
    expect(r.ragged[0].idsByClip.get('a')).toEqual(['a2']);
    expect(r.ragged[0].idsByClip.get('b')).toEqual(['b2']);
    expect(r.ragged[0].count).toBe(2);
  });

  it('duplicate module types pair positionally (front-pop)', () => {
    const a = clip('a', [dev('a1', 'gain'), dev('a2', 'gain')]);
    const b = clip('b', [dev('b1', 'gain'), dev('b2', 'gain')]);
    const r = reconcileDevices([a, b]);
    expect(r.common).toHaveLength(2);
    expect(r.common[0].idByClip.get('b')).toBe('b1');
    expect(r.common[1].idByClip.get('b')).toBe('b2');
  });

  it('leading divergence collapses into the gap before the first common (gapIndex 0)', () => {
    const a = clip('a', [dev('a1', 'lead'), dev('a2', 'shared')]);
    const b = clip('b', [dev('b1', 'shared')]);
    const r = reconcileDevices([a, b]);
    expect(r.common.map((c) => c.moduleType)).toEqual(['shared']);
    const seg = r.ragged.find((s) => s.idsByClip.get('a')?.includes('a1'));
    expect(seg!.gapIndex).toBe(0);
  });
});

describe('aggregateField', () => {
  it('all clips agree → not mixed', () => {
    const a = clip('a', [dev('a1', 'sat', { amount: 0.5 })]);
    const b = clip('b', [dev('b1', 'sat', { amount: 0.5 })]);
    const r = reconcileDevices([a, b]);
    const agg = aggregateField([a, b], r.common[0], 'amount');
    expect(agg.mixed).toBe(false);
    expect(agg.value).toBe(0.5);
    expect(agg.inUse).toEqual([0.5]);
  });

  it('one differs → mixed, inUse lists all distinct values', () => {
    const a = clip('a', [dev('a1', 'sat', { amount: 0.5 })]);
    const b = clip('b', [dev('b1', 'sat', { amount: 0.9 })]);
    const r = reconcileDevices([a, b]);
    const agg = aggregateField([a, b], r.common[0], 'amount');
    expect(agg.mixed).toBe(true);
    expect(agg.value).toBe(0.5); // clip[0]'s representative
    expect(agg.inUse.sort()).toEqual([0.5, 0.9]);
  });

  it('unset value falls back to the injected default', () => {
    const a = clip('a', [dev('a1', 'sat', { amount: 0.5 })]);
    const b = clip('b', [dev('b1', 'sat')]); // no state → default
    const r = reconcileDevices([a, b]);
    const agg = aggregateField([a, b], r.common[0], 'amount', () => 0.5);
    expect(agg.mixed).toBe(false);
    expect(agg.value).toBe(0.5);
  });
});

describe('reconcileWires', () => {
  it('a wire between two common devices in all clips → common', () => {
    const a = clip('a', [dev('a1', 'lfo'), dev('a2', 'sat')], [wire('wa', 'a1', 'out', 'a2', 'amount')]);
    const b = clip('b', [dev('b1', 'lfo'), dev('b2', 'sat')], [wire('wb', 'b1', 'out', 'b2', 'amount')]);
    const dr = reconcileDevices([a, b]);
    const wr = reconcileWires([a, b], dr);
    expect(wr.common).toHaveLength(1);
    expect(wr.common[0].repId).toBe('wa');
    expect(wr.common[0].idByClip.get('b')).toBe('wb');
    expect(wr.raggedCount).toBe(0);
  });

  it('a wire present in only one clip → ragged tally', () => {
    const a = clip('a', [dev('a1', 'lfo'), dev('a2', 'sat')], [wire('wa', 'a1', 'out', 'a2', 'amount')]);
    const b = clip('b', [dev('b1', 'lfo'), dev('b2', 'sat')]); // no wire
    const dr = reconcileDevices([a, b]);
    const wr = reconcileWires([a, b], dr);
    expect(wr.common).toHaveLength(0);
    expect(wr.raggedCount).toBe(1);
    expect(wr.raggedIdsByClip.get('a')).toEqual(['wa']);
  });

  it('a wire whose endpoint is a ragged device → ragged', () => {
    // b has an extra ragged 'extra' device; a wire into it can't be common.
    const a = clip('a', [dev('a1', 'lfo'), dev('a2', 'sat')]);
    const b = clip('b', [dev('b1', 'lfo'), dev('b2', 'extra'), dev('b3', 'sat')],
      [wire('wb', 'b1', 'out', 'b2', 'amount')]);
    const dr = reconcileDevices([a, b]);
    const wr = reconcileWires([a, b], dr);
    expect(wr.common).toHaveLength(0);
    expect(wr.raggedCount).toBe(1);
    expect(wr.raggedIdsByClip.get('b')).toEqual(['wb']);
  });
});

describe('reconcileRails', () => {
  it('a rail export common across clips; a read present in only one is ragged', () => {
    const exp = (id: string, dev: string) => ({
      id, railId: 'r1', sourceDeviceId: dev, sourceField: 'out', combine: 'add' as const, magnitude: 'auto' as const,
    });
    const rd = (id: string, dev: string) => ({
      id, railId: 'r1', targetDeviceId: dev, targetField: 'amount', combine: 'add' as const, magnitude: 'auto' as const,
    });
    const a = clip('a', [dev('a1', 'sat')], [], { exports: [exp('ea', 'a1')], reads: [rd('ra', 'a1')] });
    const b = clip('b', [dev('b1', 'sat')], [], { exports: [exp('eb', 'b1')], reads: [] });
    const dr = reconcileDevices([a, b]);
    const rr = reconcileRails([a, b], dr);
    expect(rr.exports).toHaveLength(1);
    expect(rr.exports[0].idByClip.get('b')).toBe('eb');
    expect(rr.reads).toHaveLength(0);
    expect(rr.raggedCount).toBe(1);
    expect(rr.raggedReadIdsByClip.get('a')).toEqual(['ra']);
  });
});

describe('clipInsertIndex', () => {
  it('anchors before the matched common device, after intervening ragged', () => {
    const a = clip('a', [dev('a1', 'sat'), dev('a2', 'out')]);
    const b = clip('b', [dev('b1', 'sat'), dev('b2', 'extra'), dev('b3', 'out')]);
    const dr = reconcileDevices([a, b]);
    // insert at common slot 1 (before 'out'): in b that's index 2 (after the ragged extra).
    expect(clipInsertIndex(a, dr, 1)).toBe(1);
    expect(clipInsertIndex(b, dr, 1)).toBe(2);
  });
  it('end-appends when commonIndex === common.length', () => {
    const a = clip('a', [dev('a1', 'sat')]);
    const dr = reconcileDevices([a]);
    expect(clipInsertIndex(a, dr, 1)).toBe(1);
  });
});

describe('buildMultiEditModel', () => {
  it('bundles devices + wires + rails', () => {
    const a = clip('a', [dev('a1', 'lfo'), dev('a2', 'sat')], [wire('wa', 'a1', 'out', 'a2', 'amount')]);
    const b = clip('b', [dev('b1', 'lfo'), dev('b2', 'sat')], [wire('wb', 'b1', 'out', 'b2', 'amount')]);
    const m = buildMultiEditModel([a, b]);
    expect(m.devices.common).toHaveLength(2);
    expect(m.wires.common).toHaveLength(1);
    expect(m.rails.raggedCount).toBe(0);
  });
});
