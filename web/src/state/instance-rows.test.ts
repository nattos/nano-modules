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

  it('groups clips under their track, highest track first (Resolume stack order)', () => {
    const rows = buildInstanceRows([
      inst('c1', { scope: 'clip', trackIndex: 0, trackName: 'Layer 1', clipIndex: 1, chainIndex: 0 }),
      inst('c0', { scope: 'clip', trackIndex: 0, trackName: 'Layer 1', clipIndex: 0, chainIndex: 0 }),
      inst('t1', { scope: 'clip', trackIndex: 1, trackName: 'Layer 2', clipIndex: 0, chainIndex: 0 }),
    ])!;
    // Resolume draws layer 1 at the BOTTOM, so the tab lists the highest track
    // first — otherwise the Instances tab reads upside-down vs the Arena window.
    expect(rows.map(r => r.label)).toEqual(['Layer 2', 'Layer 1']);
    // Clips still sort ASCENDING by clipIndex within a track (columns run
    // left-to-right in Resolume; only the layer stack is inverted).
    const l1 = rows[1];
    expect(l1.clips.map(c => c.key)).toEqual(['c0', 'c1']);
    expect(l1.leading).toEqual([]);
  });

  it('reverses many tracks, and keeps Main / Other trailing', () => {
    const rows = buildInstanceRows([
      inst('t0', { scope: 'clip', trackIndex: 0, trackName: 'L1', clipIndex: 0 }),
      inst('t2', { scope: 'clip', trackIndex: 2, trackName: 'L3', clipIndex: 0 }),
      inst('main', { scope: 'composition' }),
      inst('t4', { scope: 'layer', trackIndex: 4, trackName: 'LOGO' }),
      inst('t1', { scope: 'clip', trackIndex: 1, trackName: 'L2', clipIndex: 0 }),
      inst('mystery'),
    ])!;
    expect(rows.map(r => r.label)).toEqual(['LOGO', 'L3', 'L2', 'L1', 'Main', 'Other']);
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

  // A layer-mounted barrel shares the ROW of that layer's clip-mounted ones —
  // it must never fall into the catch-all "Other" lane. Both scopes key the same
  // `t:<trackIndex>` lane; the layer ones lead, the clips follow (the view draws
  // the divider between the two). The live composition this was reported against
  // happened to have no layer that carried both, so only this pins it.
  it('a layer-mounted effect shares its layer row with that layer clips (not Other)', () => {
    const rows = buildInstanceRows([
      inst('clipB', { scope: 'clip', trackIndex: 4, trackName: 'LOGO', clipIndex: 1, chainIndex: 0 }),
      inst('layB', { scope: 'layer', trackIndex: 4, trackName: 'LOGO', chainIndex: 3 }),
      inst('clipA', { scope: 'clip', trackIndex: 4, trackName: 'LOGO', clipIndex: 0, chainIndex: 0 }),
      inst('layA', { scope: 'layer', trackIndex: 4, trackName: 'LOGO', chainIndex: 1 }),
    ])!;
    expect(rows.map(r => r.label)).toEqual(['LOGO']);   // one row, no "Other"
    expect(rows[0].leading.map(i => i.key)).toEqual(['layA', 'layB']);  // chain order
    expect(rows[0].clips.map(i => i.key)).toEqual(['clipA', 'clipB']);  // clip order
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
