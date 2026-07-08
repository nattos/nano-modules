import { describe, it, expect } from 'vitest';
import { buildInstanceRows } from './instance-rows';
import type { BarrelInstanceInfo, ResolumePlacement } from './types';

function inst(key: string, placement?: ResolumePlacement): BarrelInstanceInfo {
  return { key, id: 'com.nano.nanobarrel', label: key, resolumePlacement: placement };
}

describe('buildInstanceRows', () => {
  it('returns null when nothing carries placement (playground)', () => {
    expect(buildInstanceRows([inst('a'), inst('b')])).toBeNull();
  });

  it('groups clips under their track in composition order', () => {
    const rows = buildInstanceRows([
      inst('c1', { scope: 'clip', trackIndex: 0, trackName: 'Layer 1', clipIndex: 1, chainIndex: 0 }),
      inst('c0', { scope: 'clip', trackIndex: 0, trackName: 'Layer 1', clipIndex: 0, chainIndex: 0 }),
      inst('t1', { scope: 'clip', trackIndex: 1, trackName: 'Layer 2', clipIndex: 0, chainIndex: 0 }),
    ])!;
    expect(rows.map(r => r.label)).toEqual(['Layer 1', 'Layer 2']);
    // Clips sorted by clipIndex within the track.
    expect(rows[0].clips.map(c => c.key)).toEqual(['c0', 'c1']);
    expect(rows[0].leading).toEqual([]);
  });

  it('puts track-level effects in leading, before the clips', () => {
    const rows = buildInstanceRows([
      inst('clip', { scope: 'clip', trackIndex: 0, trackName: 'L1', clipIndex: 0, chainIndex: 0 }),
      inst('lay', { scope: 'layer', trackIndex: 0, trackName: 'L1', chainIndex: 2 }),
    ])!;
    expect(rows).toHaveLength(1);
    expect(rows[0].leading.map(i => i.key)).toEqual(['lay']);
    expect(rows[0].clips.map(i => i.key)).toEqual(['clip']);
  });

  it('orders groups, then tracks, then Main', () => {
    const rows = buildInstanceRows([
      inst('main', { scope: 'composition' }),
      inst('track', { scope: 'clip', trackIndex: 0, trackName: 'L1', clipIndex: 0 }),
      inst('grp', { scope: 'group', groupIndex: 0, groupName: 'Group A' }),
    ])!;
    expect(rows.map(r => r.label)).toEqual(['Group A', 'L1', 'Main']);
  });

  it('collects placement-less instances into a trailing Other row', () => {
    const rows = buildInstanceRows([
      inst('known', { scope: 'clip', trackIndex: 0, trackName: 'L1', clipIndex: 0 }),
      inst('mystery'),
    ])!;
    expect(rows.map(r => r.label)).toEqual(['L1', 'Other']);
    expect(rows[1].leading.map(i => i.key)).toEqual(['mystery']);
  });

  it('sorts leading effects by chain index', () => {
    const rows = buildInstanceRows([
      inst('main2', { scope: 'composition', chainIndex: 1 }),
      inst('main0', { scope: 'composition', chainIndex: 0 }),
    ])!;
    expect(rows[0].leading.map(i => i.key)).toEqual(['main0', 'main2']);
  });
});
