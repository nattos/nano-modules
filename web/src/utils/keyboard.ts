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
