/**
 * Parsing of the shared server's `/global/plugins` listing into the NanoBarrel
 * instance list shown in the Organize tab. Kept dependency-free (no engine /
 * DOM imports) so it can be unit-tested without booting the app.
 */

import type { BarrelInstanceInfo, ResolumePlacement } from './types';

/**
 * Parse the native locator's `placement` object (from
 * `/global/plugins[].resolume.placement` or a composition-barrel-id entry) into
 * a `ResolumePlacement`, or undefined if it's missing/malformed. Kept lenient:
 * a legacy server (no `placement` field) or a partial object just yields
 * undefined, which the Instances tab treats as "ungrouped".
 */
export function parseResolumePlacement(raw: any): ResolumePlacement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const scope = raw.scope;
  if (scope !== 'clip' && scope !== 'layer' && scope !== 'group' && scope !== 'composition') {
    return undefined;
  }
  const num = (v: any): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: any): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    scope,
    trackIndex: num(raw.track_index),
    trackName: str(raw.track_name),
    clipIndex: num(raw.clip_index),
    clipName: str(raw.clip_name),
    groupIndex: num(raw.group_index),
    groupName: str(raw.group_name),
    chainIndex: num(raw.chain_index),
  };
}

/**
 * Parse `/global/plugins` (array of `{key, metadata, resolume?, ...}`) into the
 * NanoBarrel instance list.
 *
 * The label prefers the shared server's Resolume-derived default name (from the
 * clip/layer/group/composition the effect sits on — published under
 * `resolume.default_name`), falling back to the first UUID segment of the key.
 * In `?playground` mode there is no Resolume, so `resolume` is absent and the
 * segment label is kept.
 */
export function parseBarrelInstances(arr: any): BarrelInstanceInfo[] {
  if (!Array.isArray(arr)) return [];
  const out: BarrelInstanceInfo[] = [];
  for (const p of arr) {
    const key = p?.key;
    const id = p?.metadata?.id;
    if (typeof key !== 'string' || id !== 'com.nano.nanobarrel') continue;
    const resolumeName = p?.resolume?.default_name;
    const label = (typeof resolumeName === 'string' && resolumeName.trim())
      ? resolumeName
      : (key.split('-')[0] || key);
    out.push({
      key, id, label,
      resolumeLocation: p?.resolume?.location,
      resolumePlacement: parseResolumePlacement(p?.resolume?.placement),
    });
  }
  return out;
}
