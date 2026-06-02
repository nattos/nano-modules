/*
 * font-access.ts — main-thread OS font resolution for the text engine.
 *
 * The text engine lives in the engine worker, but the Local Font Access API
 * (`queryLocalFonts`) is a Window API available only on the main thread, and its
 * permission must be granted from a USER GESTURE. This module bridges the two:
 *
 *   1. On the first user gesture we "prime" — call queryLocalFonts() once (with
 *      transient activation so the permission prompt can show / auto-grant under
 *      Electron) and cache the resulting FontData list by family name.
 *   2. When the worker reports a spec naming an unregistered family, it posts a
 *      `fontRequest`; the main thread resolves that family's sfnt bytes from the
 *      cache and ships them back via EngineProxy.registerFont → the worker's
 *      TextEngine.registerFontBytes. The face then appears on a later frame.
 *
 * Only the bundled Noto set is pixel-parity-guaranteed (see web/FONTS.md);
 * OS fonts resolved here are best-effort and Chromium/Electron-only.
 */

// FontData is not in the ambient TS lib yet; describe the bits we use.
// queryLocalFonts() returns one entry PER FACE, so a family like "Arial" yields
// separate Regular / Bold / Italic / Bold-Italic entries that all share
// `family` — we must pick the upright regular face for the bare family name.
interface FontData { family: string; fullName: string; postscriptName: string; style?: string; blob(): Promise<Blob>; }
type QueryLocalFonts = () => Promise<FontData[]>;

// Lower = closer to "upright regular". Penalizes italic/oblique and off-regular
// weights/widths so the bare family name maps to the normal face (per-run
// bold/italic selection is a later feature — the engine doesn't carry style yet).
function faceScore(fd: FontData): number {
  const s = `${fd.style ?? ''} ${fd.fullName ?? ''} ${fd.postscriptName ?? ''}`.toLowerCase();
  let score = fd.fullName ? fd.fullName.length * 0.001 : 0;   // tie-break: shorter name
  if (/italic|oblique/.test(s)) score += 8;
  if (/\bbold\b/.test(s)) score += 4;
  if (/thin|light|black|heavy|semibold|demibold|medium|book|condensed|narrow|expanded|extra|ultra/.test(s)) score += 2;
  if (/\bregular\b|\broman\b|\bnormal\b/.test(s)) score -= 1;  // explicit regular marker
  return score;
}

/** Fonts we expect to exist on common desktop targets (macOS-first, our Electron
 *  deployment target; many also exist on Windows). Offered as picker suggestions
 *  — actual availability is confirmed via Local Font Access, and only the bundled
 *  families are parity-guaranteed. */
export const COMMON_FONT_SUGGESTIONS: string[] = [
  // Bundled (always available, parity-guaranteed)
  'Noto Sans', 'Noto Serif',
  // Cross-platform classics
  'Arial', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Georgia',
  'Courier New', 'Verdana', 'Trebuchet MS', 'Tahoma', 'Impact',
  // macOS staples
  'Menlo', 'Monaco', 'Avenir', 'Avenir Next', 'Futura', 'Optima',
  'Palatino', 'Geneva', 'Gill Sans', 'Baskerville', 'SF Pro Text',
];

let cached: Map<string, FontData> | null = null;   // family → first matching FontData
const wanted = new Set<string>();                   // families requested but not yet resolved
let registerCb: ((family: string, bytes: ArrayBuffer) => void) | null = null;

function ql(): QueryLocalFonts | null {
  const fn = (globalThis as any).queryLocalFonts;
  return typeof fn === 'function' ? fn as QueryLocalFonts : null;
}

/** True if Local Font Access exists in this context (Chromium / Electron). */
export function localFontsSupported(): boolean { return ql() !== null; }

/** Gesture-triggered: enumerate OS fonts once and cache them by family. Returns
 *  false if unsupported or the permission was denied. Idempotent. */
export async function primeLocalFonts(): Promise<boolean> {
  if (cached) return true;
  const q = ql();
  if (!q) return false;
  try {
    const list = await q();
    cached = new Map();
    // Keep the best (most upright-regular) face per family.
    for (const fd of list) {
      const prev = cached.get(fd.family);
      if (!prev || faceScore(fd) < faceScore(prev)) cached.set(fd.family, fd);
    }
    return true;
  } catch {
    return false;  // permission denied / no user activation
  }
}

/** Family names available locally (post-prime), sorted. Empty until primed. */
export function localFontFamilies(): string[] {
  return cached ? [...cached.keys()].sort((a, b) => a.localeCompare(b)) : [];
}

/** Resolve a family's sfnt bytes from the cache. Null if not primed or absent. */
export async function resolveFontBytes(family: string): Promise<ArrayBuffer | null> {
  const fd = cached?.get(family);
  if (!fd) return null;
  try { return await (await fd.blob()).arrayBuffer(); }
  catch { return null; }
}

async function tryResolve(family: string): Promise<void> {
  if (!cached || !registerCb) return;        // wait for prime / wiring
  const bytes = await resolveFontBytes(family);
  if (bytes) { registerCb(family, bytes); wanted.delete(family); }
  else wanted.delete(family);                 // not a local font — give up (one shot)
}

/** Wire the provider: `register` ships resolved bytes to the worker. Installs a
 *  one-time gesture listener that primes Local Font Access and flushes any
 *  families requested before the user interacted. Call once at boot. */
export function initFontProvider(register: (family: string, bytes: ArrayBuffer) => void): void {
  registerCb = register;
  if (!ql()) return;  // non-Chromium: OS fonts simply won't resolve (bundled set still works)
  const prime = async () => {
    if (await primeLocalFonts()) for (const f of [...wanted]) void tryResolve(f);
  };
  // Transient activation from any first interaction lets the prompt show / grant.
  window.addEventListener('pointerdown', prime, { once: true });
  window.addEventListener('keydown', prime, { once: true });
}

/** A spec named `family` and the worker can't resolve it — resolve + register it
 *  from the main thread. Queues until primed if the user hasn't interacted yet. */
export function requestFont(family: string): void {
  if (!family) return;
  wanted.add(family);
  void tryResolve(family);
}
