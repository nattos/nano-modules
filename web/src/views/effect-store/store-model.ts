/**
 * The Effects tab's pure logic: which effects show, how they group, and the
 * recent-emoji list. No DOM, no MobX — unit-tested in store-model.test.ts.
 */

import type { AvailableEffect, EffectStoreSettings, EffectStoreSort } from '../../state/types';
import type { PreviewKind } from '../../preview/scenario';
import { CATEGORY_DOMAINS, effectDomain } from '../../widgets/category-color';
import { bundleLabel } from '../../effect-bundles';
import { storeSearch } from '../../state/effect-search';

export interface StoreGroup<T> {
  id: string;
  label: string;
  effects: T[];
}

export const RECENT_EMOJI_MAX = 6;

/** Compare dotted release versions ("1.10.0" > "1.9.2"). Non-numeric parts
 *  compare as 0; a missing version sorts lowest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** "New" when the effect first shipped in the release it last changed in. */
export function versionBadge(e: AvailableEffect): 'new' | 'updated' | null {
  if (!e.changedIn) return null;
  return e.addedIn && compareVersions(e.addedIn, e.changedIn) === 0 ? 'new' : 'updated';
}

export function isDebugEffect(e: AvailableEffect): boolean {
  return e.id.startsWith('debug.') || e.bundle === 'com.nano.testonly';
}

/** Move `emoji` to the front of the recent list (deduped, capped). */
export function pushRecentEmoji(recent: readonly string[], emoji: string): string[] {
  return [emoji, ...recent.filter((e) => e !== emoji)].slice(0, RECENT_EMOJI_MAX);
}

/** Toggle `emoji` on an effect's reactions. */
export function toggleReaction(reactions: readonly string[] | undefined, emoji: string): string[] {
  const cur = reactions ?? [];
  return cur.includes(emoji) ? cur.filter((e) => e !== emoji) : [...cur, emoji];
}

const byName = <T extends AvailableEffect>(a: T, b: T) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** The order cards take within a group. Null for 'relevance', which keeps the
 *  order they arrive in (a search's ranking, else A–Z — see groupEffects). */
export function effectComparator<T extends AvailableEffect>(
  sort: EffectStoreSort,
  reactions: Record<string, string[]>,
): ((a: T, b: T) => number) | null {
  switch (sort) {
    case 'relevance': return null;
    case 'name': return byName;
    // Newest release first; untagged last. Ties: newest first-shipped, then A–Z.
    case 'newest': return (a, b) =>
      compareVersions(b.changedIn, a.changedIn) || compareVersions(b.addedIn, a.addedIn) || byName(a, b);
    case 'reacted': return (a, b) =>
      (reactions[b.id]?.length ?? 0) - (reactions[a.id]?.length ?? 0) || byName(a, b);
  }
}

/**
 * Filter + group the catalog for display. A query that RANKS (a plain search)
 * returns one "Results" group — in relevance order unless another sort is
 * picked; a path query or no query keeps the collection's grouping, each
 * group ordered by the sort.
 */
export function groupEffects<T extends AvailableEffect>(
  effects: readonly T[],
  settings: EffectStoreSettings,
  kindOf: (id: string) => PreviewKind,
  reactions: Record<string, string[]>,
  recentEmoji: readonly string[],
): StoreGroup<T>[] {
  let list = effects.filter((e) => settings.showDebug || !isDebugEffect(e));
  if (settings.show !== 'all') list = list.filter((e) => kindOf(e.id) === settings.show);
  const compare = effectComparator<T>(settings.sort ?? 'relevance', reactions);
  const found = storeSearch(list, settings.query);
  if (found.ranked) {
    const results = compare ? [...found.effects].sort(compare) : found.effects;
    return results.length ? [{ id: 'results', label: 'Results', effects: results }] : [];
  }
  list = found.effects;

  const groups = new Map<string, StoreGroup<T>>();
  const add = (id: string, label: string, e: T) => {
    let g = groups.get(id);
    if (!g) groups.set(id, g = { id, label, effects: [] });
    g.effects.push(e);
  };
  let order: string[] = [];

  switch (settings.collection) {
    case 'none': {
      for (const e of list) add('all', 'All effects', e);
      order = ['all'];
      break;
    }
    case 'category': {
      for (const e of list) {
        const d = effectDomain(e.id);
        add(d, d.charAt(0).toUpperCase() + d.slice(1), e);
      }
      const known = CATEGORY_DOMAINS as readonly string[];
      order = [...groups.keys()].sort((a, b) => {
        const ia = known.indexOf(a), ib = known.indexOf(b);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.localeCompare(b);
      });
      break;
    }
    case 'bundle': {
      for (const e of list) add(e.bundle ?? '', e.bundle ? bundleLabel(e.bundle) : 'Other', e);
      order = [...groups.keys()].sort((a, b) =>
        a === 'com.nano.core' ? -1 : b === 'com.nano.core' ? 1 : groups.get(a)!.label.localeCompare(groups.get(b)!.label));
      break;
    }
    case 'updated': {
      for (const e of list) {
        if (e.changedIn) add(`v${e.changedIn}`, `Release ${e.changedIn}`, e);
        else add('earlier', 'Earlier', e);
      }
      order = [...groups.keys()].sort((a, b) => {
        if (a === 'earlier') return 1;
        if (b === 'earlier') return -1;
        return compareVersions(b.slice(1), a.slice(1));
      });
      break;
    }
    case 'favs': {
      for (const e of list) for (const emoji of reactions[e.id] ?? []) add(emoji, emoji, e);
      const rank = (x: string) => { const i = recentEmoji.indexOf(x); return i < 0 ? 99 : i; };
      order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      break;
    }
  }
  return order.filter((id) => groups.has(id)).map((id) => {
    const g = groups.get(id)!;
    g.effects.sort(compare ?? byName);
    return g;
  });
}
