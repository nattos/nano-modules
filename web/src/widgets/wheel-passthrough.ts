/**
 * Hand a wheel event on to whatever sits UNDER an overlay.
 *
 * Wire overlays float above the editor as siblings of its scroll containers,
 * not descendants, so a wheel over a wire's hit path bubbles up through the
 * overlay and never reaches the list (or the canvas) beneath it: the list
 * simply didn't scroll while the pointer was on a wire. Making the hit paths
 * `pointer-events: none` would lose wire clicks, so instead the overlay
 * catches the wheel and re-aims it here.
 *
 * The event is re-dispatched (synthetic) at the element beneath first, so
 * anything with its own wheel handler — the canvas's alt-zoom — sees it; if
 * nothing cancels it, the nearest ancestor that can scroll that way is
 * scrolled by hand, since a synthetic wheel event never scrolls natively.
 */

/** The deepest element under (x, y), looking THROUGH `overlay` and through
 *  every shadow root on the way down. */
export function elementBeneath(overlay: HTMLElement, x: number, y: number): Element | null {
  // The overlay styles `:host([wheel-passthrough]) *` as pointer-events:none,
  // so for the length of this probe it's transparent to hit-testing.
  overlay.setAttribute('wheel-passthrough', '');
  try {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  } finally {
    overlay.removeAttribute('wheel-passthrough');
  }
}

function composedParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function canScroll(el: Element, dx: number, dy: number): boolean {
  const cs = getComputedStyle(el);
  const scrollsY = /(auto|scroll|overlay)/.test(cs.overflowY);
  const scrollsX = /(auto|scroll|overlay)/.test(cs.overflowX);
  if (dy !== 0 && scrollsY) {
    const room = dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    if (room) return true;
  }
  if (dx !== 0 && scrollsX) {
    const room = dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    if (room) return true;
  }
  return false;
}

/** Wheel deltas in pixels, whatever unit the device reported. */
function pixelDeltas(e: WheelEvent, basis: Element): [number, number] {
  const k = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? basis.clientHeight
    : 1;
  return [e.deltaX * k, e.deltaY * k];
}

/**
 * Forward `e` (a wheel event that landed on `overlay`) to what's beneath it.
 * Returns the element it went to, or null when there was nothing there.
 */
export function forwardWheelBeneath(e: WheelEvent, overlay: HTMLElement): Element | null {
  const beneath = elementBeneath(overlay, e.clientX, e.clientY);
  if (!beneath || overlay.contains(beneath)) return null;
  e.preventDefault();
  e.stopPropagation();
  const relay = new WheelEvent('wheel', {
    bubbles: true, composed: true, cancelable: true,
    clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
    deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
    altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
    buttons: e.buttons,
  });
  if (!beneath.dispatchEvent(relay)) return beneath;
  // Ctrl+wheel is the browser's pinch-zoom; never turn it into a scroll.
  if (e.ctrlKey) return beneath;
  const [dx, dy] = pixelDeltas(e, beneath);
  for (let el: Element | null = beneath; el; el = composedParent(el)) {
    if (canScroll(el, dx, dy)) {
      el.scrollBy({ left: dx, top: dy });
      break;
    }
  }
  return beneath;
}
