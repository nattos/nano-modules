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

import type { FontRequest } from './engine-types';

// FontData is not in the ambient TS lib yet; describe the bits we use.
// queryLocalFonts() returns one entry PER FACE, so a family like "Arial" yields
// separate Regular / Bold / Italic / Bold-Italic entries that all share
// `family` — we keep them all and pick the best match for a requested style.
interface FontData { family: string; fullName: string; postscriptName: string; style?: string; blob(): Promise<Blob>; }
type QueryLocalFonts = () => Promise<FontData[]>;

function faceText(fd: FontData): string {
  return `${fd.style ?? ''} ${fd.fullName ?? ''} ${fd.postscriptName ?? ''}`.toLowerCase();
}
function isItalicFace(fd: FontData): boolean { return /italic|oblique/.test(faceText(fd)); }
// Infer a numeric weight (100–900) from style/name keywords; 400 if unmarked.
// Order matters — check compound names (extrabold/semibold) before "bold".
function inferWeight(fd: FontData): number {
  const s = faceText(fd);
  if (/hairline|\bthin\b/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/\blight\b/.test(s)) return 300;
  if (/\bmedium\b/.test(s)) return 500;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/\bblack\b|\bheavy\b/.test(s)) return 900;
  if (/\bbold\b/.test(s)) return 700;
  return 400;  // regular / normal / book / roman
}

// Lower = better match for the requested (weight, italic). Italic mismatch
// dominates; then weight distance; then a small penalty for non-normal widths;
// shorter name breaks ties (prefers the plain face).
function faceScore(fd: FontData, targetWeight: number, targetItalic: boolean): number {
  let score = (isItalicFace(fd) === targetItalic) ? 0 : 1000;
  score += Math.abs(inferWeight(fd) - targetWeight);
  if (/condensed|narrow|expanded|extended/.test(faceText(fd))) score += 50;
  score += (fd.fullName?.length ?? 0) * 0.001;
  return score;
}

/** Best-matching local face for a (family, weight, italic), or null. */
function pickFace(family: string, weight: number, italic: boolean): FontData | null {
  const faces = cached?.get(family);
  if (!faces || faces.length === 0) return null;
  let best = faces[0];
  for (const fd of faces) if (faceScore(fd, weight, italic) < faceScore(best, weight, italic)) best = fd;
  return best;
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

let cached: Map<string, FontData[]> | null = null;  // family → all its faces
const wanted = new Map<string, FontRequest>();      // face key → request, pending resolution
const shippedFamilies = new Set<string>();          // families fully enumerated → worker
let registerCb: ((family: string, weight: number, italic: boolean, bytes: ArrayBuffer) => void) | null = null;

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
    // Group all faces under their family (each style picked per-request later).
    for (const fd of list) {
      const arr = cached.get(fd.family);
      if (arr) arr.push(fd); else cached.set(fd.family, [fd]);
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

/** Resolve a family's regular sfnt bytes from the cache (for a simple picker).
 *  Null if not primed or absent. */
export async function resolveFontBytes(family: string): Promise<ArrayBuffer | null> {
  const fd = pickFace(family, 400, false);
  if (!fd) return null;
  try { return await (await fd.blob()).arrayBuffer(); }
  catch { return null; }
}

async function tryResolve(req: FontRequest): Promise<void> {
  if (!cached || !registerCb) return;          // wait for prime / wiring
  const faces = cached.get(req.family);
  if (!faces || faces.length === 0) { wanted.delete(req.key); return; }  // not local — give up
  // Register EVERY face of the family with its true weight/style, so the Blitz
  // path matches any CSS font-weight/font-style exactly (no synthesis), and the
  // simple engine gets the requested styled face too. Once per family.
  if (!shippedFamilies.has(req.family)) {
    shippedFamilies.add(req.family);
    for (const fd of faces) {
      try {
        const bytes = await (await fd.blob()).arrayBuffer();
        registerCb(req.family, inferWeight(fd), isItalicFace(fd), bytes);
      } catch { /* skip this face */ }
    }
  }
  wanted.delete(req.key);
}

/** Wire the provider: `register` ships resolved bytes to the worker (keyed by the
 *  engine face key). Installs a one-time gesture listener that primes Local Font
 *  Access and flushes any faces requested before the user interacted. Call once
 *  at boot. */
export function initFontProvider(register: (family: string, weight: number, italic: boolean, bytes: ArrayBuffer) => void): void {
  registerCb = register;
  if (!ql()) return;  // non-Chromium: OS fonts simply won't resolve (bundled set still works)
  const prime = async () => {
    if (await primeLocalFonts()) for (const req of [...wanted.values()]) void tryResolve(req);
  };
  // Transient activation from any first interaction lets the prompt show / grant.
  window.addEventListener('pointerdown', prime, { once: true });
  window.addEventListener('keydown', prime, { once: true });
}

/** A spec named a styled face the worker lacks — resolve the best matching OS
 *  face and register its bytes under req.key. Queues until primed if the user
 *  hasn't interacted yet. */
export function requestFont(req: FontRequest): void {
  if (!req.family) return;
  wanted.set(req.key, req);
  void tryResolve(req);
}
