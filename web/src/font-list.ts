/**
 * font-list.ts — pure parse/format for CSS-style font-family lists.
 *
 * The `font` param of source.text.plain is a CSS font-family value: an ordered,
 * comma-separated list of family names (each optionally quoted) and/or generic
 * keywords (serif, sans-serif, …). The engine resolves the list in order,
 * falling through to the primary font for unmatched names.
 *
 * `parseFamilyList` MUST stay behaviorally identical to parseFamilyList() in
 * native/src/text/text_engine.cpp (and is re-exported by text-engine.ts) so the
 * web and native engines resolve the same ordered list. `formatFamilyList` is
 * the inverse, used by the font-field editor to serialize chips back to the
 * param string.
 *
 * No DOM / worker / wasm imports — safe to use from UI widgets.
 */

/** Split a CSS-style font-family value into ordered family names (comma-split,
 *  trimmed, surrounding quotes stripped). Empty tokens are dropped. */
export function parseFamilyList(s: string): string[] {
  const out: string[] = [];
  for (let tok of s.split(',')) {
    tok = tok.trim();
    const q = tok[0];
    if (tok.length >= 2 && (q === '"' || q === "'") && tok[tok.length - 1] === q) tok = tok.slice(1, -1);
    if (tok) out.push(tok);
  }
  return out;
}

// A family only needs quoting to survive parseFamilyList's comma-split +
// outer-quote-strip round trip: a literal comma would be mis-split, a literal
// quote could be stripped. Inner spaces are fine (parseFamilyList trims only the
// outer whitespace), so multi-word names like Times New Roman stay unquoted.
const QUOTE_NEEDED = /[",]/;

function quoteFamily(fam: string): string {
  if (!QUOTE_NEEDED.test(fam)) return fam;
  // Pick a quote char the name doesn't itself contain (realistically never both).
  return fam.includes('"') ? `'${fam}'` : `"${fam}"`;
}

/** Serialize an ordered family list back to a CSS font-family value. Trims and
 *  drops empties, quotes only what must be quoted, joins with ", ". Inverse of
 *  parseFamilyList for any realistic input. */
export function formatFamilyList(families: string[]): string {
  return families
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map(quoteFamily)
    .join(', ');
}

/** CSS generic family keywords — resolved host-side (serif → bundled Noto Serif;
 *  the rest fall through to the primary font), NOT looked up as OS fonts. */
export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/** True if `fam` is a CSS generic family keyword (case-insensitive). */
export function isGenericFamily(fam: string): boolean {
  return GENERIC_FAMILIES.has(fam.trim().toLowerCase());
}
