/**
 * Field anchor lookup — shared helpers for finding a sketch field's DOM
 * anchor (its wire-mode tap hit-box, or its gutter option pip) inside a
 * columns-view shadow root. Extracted from <taps-overlay> so overlays that
 * live OUTSIDE the editor's shadow tree (the Devices tab's cross-panel wire
 * overlay) resolve endpoints the same way instead of duplicating selectors.
 *
 * Key format: `${sketchId}/${colIdx}/${chainIdx}/${fieldPath}` — the same
 * string `hitKey`/`fieldHit` use everywhere.
 */

import { appState } from '../state/app-state';

/**
 * The sketch the ACTIVE surface's editor is editing: the unified surface
 * tracks it in `local.editingSketchId`; the effect IDE binds its editor to
 * `userSettings.selectedProjectId` instead.
 */
export function activeEditorSketchId(): string | null {
  if (appState.local.userSettings.appMode === 'effect-dev') {
    return appState.local.userSettings.selectedProjectId;
  }
  return appState.local.editingSketchId;
}

/** A field's `.tap-overlay-hit` (wire mode, expanded card) in `cvRoot`. */
export function fieldHitIn(cvRoot: ShadowRoot, key: string): HTMLElement | null {
  const [, colStr, chainStr, ...fp] = key.split('/');
  const sel = `.tap-overlay-hit[data-col-idx="${colStr}"][data-chain-idx="${chainStr}"][data-field-path="${fp.join('/')}"]`;
  for (const g of cvRoot.querySelectorAll('column-group')) {
    const hit = (g as HTMLElement).shadowRoot?.querySelector(sel) as HTMLElement | null;
    if (hit) return hit;
  }
  return null;
}

/** A field's gutter option pip (always-on wired indicator) in `cvRoot`. */
export function fieldOptionPipIn(cvRoot: ShadowRoot, fieldKey: string): HTMLElement | null {
  for (const g of cvRoot.querySelectorAll('column-group')) {
    const el = (g as HTMLElement).shadowRoot?.querySelector(
      `.field-option-pip[data-field-key="${fieldKey}"]`) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

/**
 * The ACTIVE surface's editor columns root, resolved from the document (for
 * overlays that aren't siblings of a <columns-view>). app-shell mounts one
 * tab at a time, so the left panel holds at most one editor.
 */
export function activeEditorColumnsRoot(): ShadowRoot | null {
  const cv = activeShell()?.querySelector('.left-panel sketch-column-editor')
    ?.shadowRoot?.querySelector('columns-view');
  return cv?.shadowRoot ?? null;
}

function activeShell(): ShadowRoot | null | undefined {
  const app = document.querySelector('sketch-app') ?? document.querySelector('effect-ide-app');
  return app?.shadowRoot?.querySelector('app-shell')?.shadowRoot;
}

/**
 * Every root that can hold effect cards for the active surface: the left
 * panel's linear list, plus the sidecar canvas when it's open. A field key is
 * a global address (`chainIdx` spans both partitions), so a lookup has to try
 * both — which is what lets one wire layer span the two panels.
 */
export function activeEditorColumnsRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const list = activeEditorColumnsRoot();
  if (list) roots.push(list);
  const canvas = activeShell()?.querySelector('sketch-canvas-view')?.shadowRoot;
  if (canvas) roots.push(canvas);
  return roots;
}

/** Best anchor for a field on ANY of the active surface's roots. */
export function activeEditorFieldAnchor(key: string): HTMLElement | null {
  for (const root of activeEditorColumnsRoots()) {
    const el = fieldHitIn(root, key) ?? fieldOptionPipIn(root, key);
    if (el) return el;
  }
  return null;
}

/**
 * Scroll the active editor to a field and flash a locator halo on it — the
 * "locate" affordance (Devices tab wire rows). Polls per-rAF until the anchor
 * exists, so it works right after an `editSketch` switch while the editor is
 * still rendering the new instance; gives up quietly after `timeoutMs` (a
 * collapsed region / pruned field simply never resolves an anchor).
 */
export function scrollToAndFlashField(key: string, timeoutMs = 4000): void {
  const t0 = performance.now();
  const attempt = () => {
    const el = activeEditorFieldAnchor(key);
    if (!el) {
      if (performance.now() - t0 < timeoutMs) requestAnimationFrame(attempt);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashAnchor(el);
  };
  requestAnimationFrame(attempt);
}

/**
 * Pulse a viewport-fixed halo centered on `el`, tracking it per-rAF (the
 * smooth scroll above is still moving it). Drawn as an overlay on
 * document.body rather than styling `el` itself — the anchor lives in a
 * foreign shadow tree whose styles we shouldn't reach into.
 */
function flashAnchor(el: HTMLElement): void {
  const SIZE = 36;
  const DURATION = 1800;
  const ring = document.createElement('div');
  ring.style.cssText =
    `position:fixed;z-index:1000;pointer-events:none;width:${SIZE}px;height:${SIZE}px;` +
    'border:2px solid var(--app-io-output, #ff8c00);border-radius:50%;' +
    'box-shadow:0 0 12px 2px rgba(255,140,0,0.55);';
  document.body.appendChild(ring);
  ring.animate(
    [
      { opacity: 1, transform: 'scale(0.4)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.55 },
      { opacity: 0, transform: 'scale(1.35)' },
    ],
    { duration: DURATION / 3, iterations: 3, easing: 'ease-out' },
  );
  const t0 = performance.now();
  const track = () => {
    if (!el.isConnected || performance.now() - t0 >= DURATION) { ring.remove(); return; }
    const r = el.getBoundingClientRect();
    ring.style.left = `${r.left + r.width / 2 - SIZE / 2}px`;
    ring.style.top = `${r.top + r.height / 2 - SIZE / 2}px`;
    requestAnimationFrame(track);
  };
  track();
}
