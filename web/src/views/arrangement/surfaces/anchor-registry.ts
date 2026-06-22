/**
 * Cross-shadow anchor registry. Components register DOM elements under stable
 * keys; the global wire overlay (arr-overlay) looks them up by key and reads
 * their viewport rects to route wires — without fragile deep shadow queries.
 *
 * Anchors that come and go (trace cards, field editors) are re-registered on
 * each render; lookups self-prune disconnected / zero-size elements.
 */

const anchors = new Map<string, Element>();

export function setAnchor(key: string, el: Element | null | undefined): void {
  if (el) anchors.set(key, el);
  else anchors.delete(key);
}

export function clearAnchor(key: string): void {
  anchors.delete(key);
}

export function anchorRect(key: string): DOMRect | null {
  const el = anchors.get(key);
  if (!el || !el.isConnected) {
    if (el) anchors.delete(key);
    return null;
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return r;
}

export const AnchorKeys = {
  clip: (clipId: string) => `clip:${clipId}`,
  rail: (railId: string) => `rail:${railId}`,
  trace: (clipId: string) => `trace:${clipId}`,
  field: (deviceId: string, field: string) => `field:${deviceId}:${field}`,
  beatwarp: () => 'beatwarp',
  mainbus: () => 'mainbus',
};
