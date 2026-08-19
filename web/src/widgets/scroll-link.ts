/**
 * Vertical scroll link between the linear effects list and the sidecar canvas.
 *
 * At default zoom the two surfaces scroll together, so a canvas node sits beside
 * the effect it modulates. They live in SIBLING panels under <app-shell>, so
 * neither can pass a property to the other and walking the DOM every frame would
 * be waste — a tiny push-based broker instead.
 *
 * Deliberately not a MobX reaction and not part of appState: this is transient
 * view coupling, nothing persists through it, and driving it from a reaction
 * would re-render both surfaces on every scroll frame.
 */

export type ScrollSource = 'linear' | 'canvas';

type Listener = (source: ScrollSource, top: number) => void;

const listeners = new Set<Listener>();
let lastLinearTop = 0;

/** Announce a surface's new scroll position. */
export function publishScroll(source: ScrollSource, top: number): void {
  if (source === 'linear') lastLinearTop = top;
  for (const fn of listeners) fn(source, top);
}

/** Subscribe; returns an unsubscribe. */
export function subscribeScroll(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The list's last published scroll top. The canvas reads this when it re-links
 * (or first mounts) so it can catch up without waiting for the next scroll.
 */
export function linearScrollTop(): number {
  return lastLinearTop;
}
