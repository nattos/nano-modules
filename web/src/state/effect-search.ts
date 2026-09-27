/**
 * Effect search — the matching rules shared by the type picker
 * (<smart-input>) and the effect store's query bar, so both find the same
 * effects for the same text.
 *
 *   - A plain query ranks every effect by `matchScore` (exact id/short name,
 *     prefixes, then fuzzy over short name, name, keywords, category).
 *   - A dotted query is a PATH: text before the last dot names a folder of the
 *     id taxonomy ("color.tone") or a bundle id ("com.nano.core"), and text
 *     after it searches within that folder. A path nothing lives under falls
 *     back to a plain query over the whole text.
 */

import type { AvailableEffect } from './types';

export function shortName(id: string) { return id.split('.').pop() ?? id; }

/** Simple fuzzy match: all query chars must appear in order in the target. */
export function fuzzyMatch(q: string, t: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Score a match — lower is better. Returns -1 for no match. */
export function matchScore(query: string, effect: AvailableEffect): number {
  const q = query.toLowerCase();
  const id = effect.id.toLowerCase();
  const name = effect.name.toLowerCase();
  const short = shortName(effect.id).toLowerCase();

  // Full dotted-id matches first, so a path-style query ("color.tone.bright")
  // resolves straight to its effect (drives live preview + express commit when
  // the field is seeded with a full identifier).
  if (id === q || short === q) return 0;
  if (id.startsWith(q)) return 1;
  if (short.startsWith(q)) return 1;
  if (name === q) return 2;
  if (name.startsWith(q)) return 3;
  if (fuzzyMatch(q, short)) return 4;
  if (fuzzyMatch(q, name)) return 5;
  for (const kw of effect.keywords) {
    if (kw.toLowerCase().startsWith(q)) return 6;
    if (fuzzyMatch(q, kw)) return 7;
  }
  if (fuzzyMatch(q, effect.category.toLowerCase())) return 8;
  return -1;
}

/** Rank effects by `matchScore` (best first), dropping non-matches. */
function rank<T extends AvailableEffect>(effects: readonly T[], q: string): T[] {
  return effects
    .map(e => ({ effect: e, score: matchScore(q, e) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map(x => x.effect);
}

/** Search effects and return scored results (best first). */
export function searchEffects<T extends AvailableEffect>(effects: readonly T[], query: string): T[] {
  const q = query.trim();
  if (q.length === 0) return [...effects];
  return rank(effects, q);
}

export interface StoreSearchResult<T> {
  effects: T[];
  /** True when `effects` is in relevance order (the store then lists them
   *  flat); false when the query only narrowed the set (grouping stands). */
  ranked: boolean;
}

/** The store's query: the picker's rules (plain or path), as one result list. */
export function storeSearch<T extends AvailableEffect>(effects: readonly T[], query: string): StoreSearchResult<T> {
  const q = query.trim();
  if (!q) return { effects: [...effects], ranked: false };
  const lastDot = q.lastIndexOf('.');
  if (lastDot > 0) {
    const path = q.slice(0, lastDot);
    const sub = q.slice(lastDot + 1);
    const isBundle = effects.some(e => e.bundle === path);
    const under = isBundle
      ? effects.filter(e => e.bundle === path)
      : effects.filter(e => e.id.startsWith(path + '.'));
    if (under.length) return sub ? { effects: rank(under, sub), ranked: true } : { effects: under, ranked: false };
  }
  return { effects: rank(effects, q), ranked: true };
}
