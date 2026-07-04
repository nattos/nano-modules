/**
 * Common Cmd/Ctrl-based editing shortcuts — Select All, Copy, Cut, Paste,
 * Undo, Redo —
 * shared by every AppController-driven, <column-group>-based surface (the
 * effect IDE and the sketch IDE). Extracted so the two can't silently drift
 * out of sync with each other, which is exactly how the sketch IDE ended up
 * missing Copy/Paste and both ended up missing Cut and Undo/Redo keyboard
 * shortcuts in the first place.
 *
 * Call this near the top of a surface's own keydown handler, after the
 * `isTypingInEditable()` guard and before any surface-specific key handling.
 */

import { appController } from '../state/controller';

/** Returns true if the event was handled (and already preventDefault'd). */
export function handleCommonEditShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const k = e.key.toLowerCase();

  if (k === 'z') {
    e.preventDefault();
    if (e.shiftKey) appController.redo();
    else appController.undo();
    return true;
  }
  if (e.shiftKey) return false; // no Shift-modified copy/cut/paste combos here

  if (k === 'a') {
    // Select-all: multi-select every effect card in the edited sketch. With no
    // sketch (or an empty one) leave the event to the browser's own select-all.
    if (!appController.selectAllEffects()) return false;
    e.preventDefault();
    return true;
  }
  if (k === 'c') {
    if (!appController.canCopy) return false; // let the browser's own copy run
    e.preventDefault();
    appController.copySelection();
    return true;
  }
  if (k === 'x') {
    if (!appController.canCut) return false;
    e.preventDefault();
    appController.cutSelection();
    return true;
  }
  if (k === 'v') {
    // Paste always attempts (it may also resolve from the OS clipboard, which
    // can't be checked synchronously) — a no-op when nothing pasteable is found.
    e.preventDefault();
    void appController.pasteClipboard();
    return true;
  }
  return false;
}
