/**
 * Shared helpers for file drag-and-drop.
 *
 * The IDE supports a layered drop model: a page-level fallback loads a dropped
 * file into the selected sketch's input, while more specific drop zones (e.g.
 * <texture-drop-zone>) can OVERRIDE that default. Override works by calling
 * `stopPropagation()` in the specific zone's drop handler — drag events are
 * composed and bubble out of shadow trees, so halting propagation there keeps
 * the event from reaching the page-level host listener. Use `claimDrop` to make
 * that intent explicit at a call site.
 */

/** True when a drag carries OS files (vs. text/element drags). */
export function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

/**
 * Mark a drag/drop event as handled by a specific zone, overriding any
 * page-level fallback. Prevents the browser's default (file open / navigate)
 * and stops the composed event from bubbling to ancestor host listeners.
 */
export function claimDrop(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
}
