/**
 * Parsing of the shared server's `/global/plugins` listing into the NanoBarrel
 * instance list shown in the Organize tab. Kept dependency-free (no engine /
 * DOM imports) so it can be unit-tested without booting the app.
 */

import type { BarrelInstanceInfo } from './types';

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
    out.push({ key, id, label, resolumeLocation: p?.resolume?.location });
  }
  return out;
}
