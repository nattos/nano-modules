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
  const app = document.querySelector('sketch-app') ?? document.querySelector('effect-ide-app');
  const shell = app?.shadowRoot?.querySelector('app-shell');
  const editor = shell?.shadowRoot?.querySelector('.left-panel sketch-column-editor');
  const cv = editor?.shadowRoot?.querySelector('columns-view');
  return cv?.shadowRoot ?? null;
}

/** Best anchor for a field in the active editor: tap hit, else gutter pip. */
export function activeEditorFieldAnchor(key: string): HTMLElement | null {
  const root = activeEditorColumnsRoot();
  if (!root) return null;
  return fieldHitIn(root, key) ?? fieldOptionPipIn(root, key);
}
