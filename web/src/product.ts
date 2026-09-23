/**
 * Which desktop product this renderer is running inside.
 *
 * The desktop build is two apps sharing one vite build and one Electron shell:
 *
 *   - `arrangement` — NanoModules, the arrangement / video editor alone.
 *   - `remote`      — NanoModules Remote Control, the live-show app: Remote
 *                     Control (the `live` app mode) and Playground. Effect Dev
 *                     is not part of it.
 *
 * The shell (electron/main.cjs) decides which and tells the page through the
 * preload (`window.nanoProduct`). In a plain browser — the dev server, the e2e
 * suite — there is no product, and every mode stays reachable so development
 * loses nothing.
 */

import type { AppMode } from './resolume-mode';

export type NanoProduct = 'arrangement' | 'remote';

export function nanoProduct(): NanoProduct | null {
  const p = (globalThis as any).nanoProduct;
  return p === 'arrangement' || p === 'remote' ? p : null;
}

/** The modes this product offers, in display order. */
export function availableModes(product: NanoProduct | null = nanoProduct()): AppMode[] {
  return product === 'remote'
    ? ['live', 'playground']
    : ['effect-dev', 'live', 'playground'];
}

/** Map a persisted or URL-requested mode onto one this product offers. A
 *  Remote Control install that inherited `effect-dev` lands in Remote Control. */
export function coerceMode(mode: AppMode, product: NanoProduct | null = nanoProduct()): AppMode {
  return availableModes(product).includes(mode) ? mode : 'live';
}
