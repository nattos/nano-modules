/**
 * Control-alias grouping + last-touched resolution. Lock-step twin:
 * native/src/midi/midi_alias.h (test_midi_alias.cpp).
 */
import { describe, it, expect } from 'vitest';
import {
  aliasEdgeKey, aliasEndpointKey, aliasGroupIndex, aliasGroups, aliasWinner,
  type AliasEdge, type AliasEndpoint, type AliasSample,
} from './alias-groups';

const ep = (deviceId: string, field: string): AliasEndpoint => ({ deviceId, field });
const edge = (a: AliasEndpoint, b: AliasEndpoint): AliasEdge => ({ a, b });
const keys = (group: AliasEndpoint[]) => group.map(e => `${e.deviceId}/${e.field}`);

describe('aliasEdgeKey', () => {
  it('is orientation-independent', () => {
    const a = ep('d1', 'b0/e00/turn'), b = ep('d2', 'b1/e02/turn');
    expect(aliasEdgeKey(a, b)).toBe(aliasEdgeKey(b, a));
  });
  it('separates devices from fields (no key collisions across the join)', () => {
    expect(aliasEndpointKey('a', 'b/c')).not.toBe(aliasEndpointKey('a/b', 'c'));
  });
});

describe('aliasGroups', () => {
  it('pairs two endpoints', () => {
    const groups = aliasGroups([edge(ep('d1', 'b0/e00/turn'), ep('d2', 'b0/e00/turn'))]);
    expect(groups).toHaveLength(1);
    expect(keys(groups[0])).toEqual(['d1/b0/e00/turn', 'd2/b0/e00/turn']);
  });

  it('merges a chain into ONE group (A↔B, B↔C ⇒ {A,B,C})', () => {
    const groups = aliasGroups([
      edge(ep('d1', 'x'), ep('d2', 'x')),
      edge(ep('d2', 'x'), ep('d3', 'x')),
    ]);
    expect(groups).toHaveLength(1);
    expect(keys(groups[0])).toEqual(['d1/x', 'd2/x', 'd3/x']);
  });

  it('keeps unrelated pairs apart', () => {
    const groups = aliasGroups([
      edge(ep('d1', 'x'), ep('d2', 'x')),
      edge(ep('d1', 'y'), ep('d2', 'y')),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map(keys)).toEqual([['d1/x', 'd2/x'], ['d1/y', 'd2/y']]);
  });

  it('ignores self-edges and duplicates, and never emits a singleton', () => {
    expect(aliasGroups([edge(ep('d1', 'x'), ep('d1', 'x'))])).toEqual([]);
    const twice = aliasGroups([
      edge(ep('d1', 'x'), ep('d2', 'x')),
      edge(ep('d2', 'x'), ep('d1', 'x')),
    ]);
    expect(twice).toHaveLength(1);
    expect(keys(twice[0])).toEqual(['d1/x', 'd2/x']);
  });

  it('is order-independent — two clients on one document agree', () => {
    const edges = [
      edge(ep('d3', 'x'), ep('d1', 'x')),
      edge(ep('d2', 'x'), ep('d3', 'x')),
      edge(ep('d9', 'y'), ep('d8', 'y')),
    ];
    const a = aliasGroups(edges).map(keys);
    const b = aliasGroups([...edges].reverse()).map(keys);
    expect(a).toEqual(b);
  });
});

describe('aliasWinner', () => {
  const group = [ep('desk', 'b0/e00/turn'), ep('spare', 'b0/e00/turn')];
  const table = (entries: Record<string, AliasSample>) =>
    (e: AliasEndpoint) => entries[`${e.deviceId}/${e.field}`];

  it('takes the most recently written member', () => {
    expect(aliasWinner(group, table({
      'desk/b0/e00/turn': { value: 0.2, seq: 7 },
      'spare/b0/e00/turn': { value: 0.9, seq: 3 },
    }))).toEqual({ value: 0.2, seq: 7 });
  });

  it('lets the spare take over once the desk stops writing', () => {
    // The desk's last value is stale (seq 7); the spare is touched after.
    expect(aliasWinner(group, table({
      'desk/b0/e00/turn': { value: 0.2, seq: 7 },
      'spare/b0/e00/turn': { value: 0.9, seq: 8 },
    }))?.value).toBe(0.9);
  });

  it('falls back to the only member with a value', () => {
    expect(aliasWinner(group, table({
      'spare/b0/e00/turn': { value: 0.5, seq: 1 },
    }))).toEqual({ value: 0.5, seq: 1 });
  });

  it('resolves to nothing when nobody has been touched (dormant)', () => {
    expect(aliasWinner(group, table({}))).toBeNull();
  });

  it('breaks a sequence tie on endpoint key, so hosts agree', () => {
    expect(aliasWinner(group, table({
      'desk/b0/e00/turn': { value: 0.2, seq: 4 },
      'spare/b0/e00/turn': { value: 0.9, seq: 4 },
    }))?.value).toBe(0.2);   // 'desk\0…' < 'spare\0…'
  });
});

describe('aliasGroupIndex', () => {
  it('maps every member endpoint to its group', () => {
    const groups = aliasGroups([edge(ep('d1', 'x'), ep('d2', 'x'))]);
    const index = aliasGroupIndex(groups);
    expect(index.size).toBe(2);
    expect(index.get(aliasEndpointKey('d1', 'x'))).toBe(groups[0]);
    expect(index.get(aliasEndpointKey('d2', 'x'))).toBe(groups[0]);
  });
});
