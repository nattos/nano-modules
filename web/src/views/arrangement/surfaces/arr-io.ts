/**
 * Composition I/O — the arrangement-side glue shared by the header I/O strip
 * (<arr-io-strip>) and the wire overlay (<arr-overlay>):
 *
 *   - `portConnect`: the wire-gesture machine a PORT pip starts drags from.
 *     Field-started gestures run on each column adapter's own WireConnect;
 *     both land in store.connectSketchWire, which turns anything touching a
 *     port into a route (store.connectRoute).
 *   - route-end labels ("MAIN_COMP · Blend.tex_b") for chips and popups;
 *   - `routeFieldRect`: where a route's FIELD end sits on screen — the
 *     inspector's field hit-box, when that sketch is the one inspected.
 */

import type { Sketch } from '../../../sketch-types';
import type { PluginInfo } from '../../../widgets/column-adapter';
import { WireConnect } from '../../../widgets/taps-connect';
import { store } from '../state/store';
import { PORT_IN, PORT_OUT, type RouteEnd, type Track } from '../model/composition';
import { catalogEffect } from '../engine/effect-catalog';

/** The gesture machine for drags that START on a port pip. */
export const portConnect = new WireConnect({
  getSketch: (sketchId: string): Sketch | undefined => {
    const sk = store.sketchForId(sketchId);
    if (!sk) return undefined;
    return {
      anchor: null,
      chain: sk.devices.map((d) => ({
        type: 'module' as const, module_type: d.moduleType, instance_key: d.id,
      })),
      instances: Object.fromEntries(sk.devices.map((d) => [
        d.id, { module_type: d.moduleType, state: (d.state ?? {}) as Record<string, unknown> },
      ])),
      wires: sk.wires ?? [],
    } as Sketch;
  },
  getPlugin: (mt: string) => store.enginePlugin(mt) as unknown as PluginInfo | undefined,
  connectWire: (a, b) => store.connectSketchWire(a, b),
});

/** A port's display name. */
export function portName(track: Track, portId: string): string {
  if (portId === PORT_IN) return 'in';
  if (portId === PORT_OUT) return 'out';
  return track.ports?.find((p) => p.id === portId)?.name ?? '?';
}

/** Which way a port faces. */
export function portDir(track: Track, portId: string): 'in' | 'out' {
  if (portId === PORT_IN) return 'in';
  if (portId === PORT_OUT) return 'out';
  return track.ports?.find((p) => p.id === portId)?.dir ?? 'out';
}

/** "Track · port" or "Track · Device.field" (clip ends name the clip). */
export function routeEndLabel(e: RouteEnd): string {
  const t = store.trackById(e.trackId);
  const tn = t ? store.trackDisplayName(t) : '?';
  if (e.kind === 'port') return `${tn} · ${t ? portName(t, e.portId) : e.portId}`;
  const sk = e.clipId ? t?.clips.find((c) => c.id === e.clipId) : undefined;
  const devs = e.clipId ? sk?.sketch.devices : t?.sketch.devices;
  const dev = devs?.find((d) => d.id === e.deviceId);
  const dn = dev ? (catalogEffect(dev.moduleType)?.name ?? dev.name) : '?';
  return `${sk ? `${tn}/${sk.name}` : tn} · ${dn}.${e.field}`;
}

/** The editor sketch id a field end lives in. */
export function routeFieldSketchId(e: Extract<RouteEnd, { kind: 'field' }>): string {
  return e.clipId ? `clip/${e.trackId}/${e.clipId}` : `track/${e.trackId}`;
}

// ── Inspector field lookup ────────────────────────────────────────────────

type FieldLookup = (sketchId: string, chainIdx: number, field: string) => Element | null;
let inspectorLookup: FieldLookup | null = null;

/** The inspector registers how to find a field's hit-box in its cards. */
export function setInspectorFieldLookup(fn: FieldLookup | null) {
  inspectorLookup = fn;
}

/** Viewport rect of a route's FIELD end, or null when it isn't on screen. */
export function routeFieldRect(e: Extract<RouteEnd, { kind: 'field' }>): DOMRect | null {
  if (!inspectorLookup) return null;
  const sketchId = routeFieldSketchId(e);
  const idx = store.sketchForId(sketchId)?.devices.findIndex((d) => d.id === e.deviceId) ?? -1;
  if (idx < 0) return null;
  const el = inspectorLookup(sketchId, idx, e.field);
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 ? r : null;
}

/** Select what a field end lives in, so the inspector shows it. */
export function revealRouteField(e: Extract<RouteEnd, { kind: 'field' }>) {
  store.setSelection([e.clipId ? `clip/${e.trackId}/${e.clipId}` : `track/${e.trackId}`]);
}
