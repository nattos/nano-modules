/**
 * Arrangement cross-shadow anchor registry — the KEYING layer over the shared
 * rect tracker. Components register DOM elements under stable keys; the global
 * wire overlay (arr-overlay) looks them up by key and reads their viewport rects
 * to route wires — without fragile deep shadow queries.
 *
 * The tracking implementation is the SAME `FieldLayoutManager` the effect IDE
 * uses for field editors — there is one rect-tracking system, not two. This
 * module only owns the arrangement's key vocabulary (`AnchorKeys`) and a
 * surface-scoped manager instance. Anchors that come and go (trace cards, field
 * editors) are re-registered on each render; lookups self-prune disconnected /
 * zero-size elements (`liveRect`).
 */

import { FieldLayoutManager } from '../../../widgets/field-layout-manager';

/** One shared rect tracker for the whole arrangement surface. */
const layout = new FieldLayoutManager();

export function setAnchor(key: string, el: Element | null | undefined): void {
  layout.setAnchor(key, (el as HTMLElement | null | undefined) ?? null);
}

export function clearAnchor(key: string): void {
  layout.unregister(key);
}

export function anchorRect(key: string): DOMRect | null {
  return layout.liveRect(key);
}

export const AnchorKeys = {
  clip: (clipId: string) => `clip:${clipId}`,
  rail: (railId: string) => `rail:${railId}`,
  trace: (clipId: string) => `trace:${clipId}`,
  field: (deviceId: string, field: string) => `field:${deviceId}:${field}`,
  beatwarp: () => 'beatwarp',
  mainbus: () => 'mainbus',
};
