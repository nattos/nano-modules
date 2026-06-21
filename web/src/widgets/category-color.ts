/**
 * Per-category (taxonomy domain) accent colours.
 *
 * Effect ids are dotted paths whose FIRST segment is the domain
 * (`source.light.chroma_wave` → `source`). Each domain gets one muted accent,
 * defined as a `--app-cat-*` CSS custom property in `style.css`; this module is
 * the shared way to map an id → domain → colour expression so both Lit inline
 * styles and CodeMirror CSS classes draw from one source of truth.
 *
 * Kept deliberately subtle — this is a visual / event-design tool, so the
 * colour is a quiet hint (a small dot), never decoration.
 */

export const CATEGORY_DOMAINS = [
  'source', 'color', 'filter', 'warp', 'composite',
  'motion', 'mod', 'control', 'debug',
] as const;
export type CategoryDomain = typeof CATEGORY_DOMAINS[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(CATEGORY_DOMAINS);

/** First path segment of an effect id — its taxonomy domain / category. */
export function effectDomain(id: string): string {
  const i = id.indexOf('.');
  return i > 0 ? id.slice(0, i) : id;
}

/** True when `domain` is one of the known taxonomy domains (has an accent). */
export function isCategoryDomain(domain: string): boolean {
  return DOMAIN_SET.has(domain);
}

/**
 * A CSS colour expression for a domain's accent — a `var(--app-cat-*)`
 * reference, or a neutral fallback for ids outside the known taxonomy.
 */
export function categoryColor(domain: string): string {
  return DOMAIN_SET.has(domain)
    ? `var(--app-cat-${domain})`
    : 'var(--app-text-color2, #B0B0B0)';
}
