/**
 * Where an element is actually VISIBLE: the intersection of the viewport with
 * every clipping (overflow ≠ visible) ancestor's box, walked through shadow
 * roots. For overlays that draw to anchors living inside scroll containers —
 * an anchor scrolled out of its panel still has a perfectly good rect, just
 * one far outside the panel (or the window), and a line drawn to it flies off
 * the screen. Pin the endpoint to this rect instead.
 */

export interface ClipBox { left: number; top: number; right: number; bottom: number }

/** Clipping ancestors per element. An element keeps its ancestors for its
 *  whole life in practice (lit moves nodes by re-creating them), so the
 *  getComputedStyle walk runs once per anchor, not once per frame. */
const clipAncestors = new WeakMap<Element, Element[]>();

function composedParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function ancestorsOf(el: Element): Element[] {
  let list = clipAncestors.get(el);
  if (list) return list;
  list = [];
  for (let a = composedParent(el); a && a !== document.documentElement; a = composedParent(a)) {
    const cs = getComputedStyle(a);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') list.push(a);
    // Nothing above a fixed box can clip it except the viewport.
    if (cs.position === 'fixed') break;
  }
  clipAncestors.set(el, list);
  return list;
}

/** The visible box `el` can draw into — never larger than the viewport. */
export function visibleClip(el: Element): ClipBox {
  const box: ClipBox = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (const a of ancestorsOf(el)) {
    const r = a.getBoundingClientRect();
    box.left = Math.max(box.left, r.left);
    box.top = Math.max(box.top, r.top);
    box.right = Math.min(box.right, r.right);
    box.bottom = Math.min(box.bottom, r.bottom);
  }
  return box;
}

/** `(x, y)` pinned inside `clip`, and whether it had to move. A clip that
 *  collapsed to nothing (the panel itself is off-screen) pins to its edge. */
export function pinToClip(x: number, y: number, clip: ClipBox): { x: number; y: number; pinned: boolean } {
  const px = Math.min(Math.max(x, clip.left), Math.max(clip.left, clip.right));
  const py = Math.min(Math.max(y, clip.top), Math.max(clip.top, clip.bottom));
  return { x: px, y: py, pinned: px !== x || py !== y };
}
