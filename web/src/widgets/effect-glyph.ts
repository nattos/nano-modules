/**
 * Effect "glyph" helpers — sanitize the optional per-effect picker visual that
 * an effect declares over the module ABI (`icon` metadata string, or a small
 * `thumbnail` base64 PNG). Both are UNTRUSTED: the value comes straight from a
 * wasm bundle, so it must be validated before it ever touches the DOM or a CSS
 * class.
 *
 *   icon      → a Line Awesome class name (e.g. "la-bolt"). Validated against
 *               the real Line Awesome glyph set, so a typo or an injection
 *               attempt (extra classes, whitespace, non-glyph names) is
 *               rejected and the picker falls back to the category dot.
 *   thumbnail → a 32×32-ish PNG, base64-encoded (or a full data: URI). Validated
 *               to a safe `data:image/*;base64,…` URI, length-capped.
 *
 * See `<smart-input>` for the consumer.
 */

// @ts-ignore — `?raw` is a Vite-native suffix that returns the file as a string.
import lineawesomecss from 'line-awesome/dist/line-awesome/css/line-awesome.css?raw';

/**
 * The set of real Line Awesome glyph class names, harvested once from the
 * bundled stylesheet. Only classes with a `::before { content }` rule are
 * glyphs (sizing/util modifiers like `la-lg`/`la-spin` have none), so this is
 * exactly the set `<ui-icon>` can render — the authoritative allow-list.
 */
const ICON_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  const re = /\.(la-[a-z0-9-]+)::?before/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineawesomecss as string)) !== null) set.add(m[1]);
  return set;
})();

/** Exposed for tests: how many glyphs the allow-list recognizes (>0 => loaded). */
export function knownIconCount(): number { return ICON_SET.size; }

/**
 * Validate an effect-declared icon name. Returns a safe `la-*` class, or `null`.
 * A bare name ("bolt") is tolerated by prefixing `la-`; anything with unexpected
 * characters (spaces, dots, another class) is rejected outright — never passed
 * through to a class attribute. The strict shape check IS the injection
 * guarantee; the allow-list is an extra refinement that rejects well-formed but
 * non-existent glyphs (which would render as an empty box) so the picker falls
 * back to its category dot. When the stylesheet can't be read (some test/build
 * transforms strip CSS imports) the allow-list is empty and we keep the
 * shape-validated name rather than reject everything.
 */
export function sanitizeIconName(raw?: string | null): string | null {
  if (!raw) return null;
  let name = raw.trim().toLowerCase();
  if (!name) return null;
  if (!name.startsWith('la-')) name = `la-${name}`;
  // Strict shape: `la-` + hyphen-separated alphanumeric segments, bounded.
  if (name.length > 40) return null;
  if (!/^la-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
  if (ICON_SET.size === 0) return name; // allow-list unavailable — shape only
  return ICON_SET.has(name) ? name : null;
}

/** ~18KB of base64 — ample headroom for a 32×32 PNG, a hard cap against abuse. */
const MAX_THUMBNAIL_CHARS = 24000;

/**
 * Validate an effect-declared thumbnail into a safe image data URI, or `null`.
 * Accepts a full `data:image/{png,webp,jpeg};base64,…` URI or a bare base64
 * body (assumed PNG). Rejects any other `data:` scheme, non-base64 payloads,
 * and oversized blobs. The result is only ever used as an `<img src>`, which
 * cannot execute script.
 */
export function thumbnailDataUri(raw?: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s.length > MAX_THUMBNAIL_CHARS) return null;

  const dataUri = /^data:image\/(?:png|webp|jpe?g);base64,([a-z0-9+/]+=*)$/i.exec(s);
  if (dataUri) return isBase64(dataUri[1]) ? s : null;
  if (s.startsWith('data:')) return null; // some other data: scheme — reject

  return isBase64(s) ? `data:image/png;base64,${s}` : null;
}

function isBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && /^[a-z0-9+/]+=*$/i.test(s);
}
