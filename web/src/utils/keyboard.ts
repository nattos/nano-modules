/**
 * Return true if the keyboard event originated from an editable surface
 * (text input, contenteditable, CodeMirror) — including ones nested inside
 * shadow DOM. We can't use `e.target` for this because events crossing a
 * shadow boundary are retargeted to the shadow host; the editable element
 * inside the shadow tree becomes invisible.
 *
 * `composedPath()` walks the FULL bubbling path, including shadow DOM
 * internals, so we see the cm-content / input / textarea even if the host
 * is many shadow boundaries away.
 */
export function isTypingInEditable(e: Event): boolean {
  const path = e.composedPath();
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (node.isContentEditable) return true;
    if (node.classList && node.classList.contains('cm-content')) return true;
  }
  return false;
}

/**
 * Return true if the keyboard event is targeted at a focused field-control host
 * — a knob/slider/number/toggle/etc. value editor on a card.
 *
 * Unlike a bare `<input>`, these are focusable custom-element hosts (they set
 * `tabindex` on themselves and render an inner `<input>` only while editing), so
 * `isTypingInEditable` misses them when they hold focus but aren't in edit mode.
 * We detect them structurally: a focusable (`tabindex >= 0`) custom element
 * (hyphenated tag) in the event path. The effect card is a plain non-focusable
 * `<div>`, so it never matches — this lets a focused field own Delete/Backspace
 * (reset to default) instead of the global handler deleting the whole card.
 */
export function isFieldControlFocused(e: Event): boolean {
  for (const node of e.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.tabIndex >= 0 && node.localName.includes('-')) return true;
  }
  return false;
}
