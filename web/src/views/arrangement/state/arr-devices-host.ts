/**
 * The arrangement's DevicesHost: the Devices panel (the same one Remote
 * Control uses) over this page's store. Installed on import — arrangement-app
 * imports it before mounting <devices-tab>.
 *
 *   - Wires live in the composition's sketches (every lane and clip,
 *     sequence interiors included), presented in the editor's Sketch shape so
 *     the panel's wire model resolves their destinations.
 *   - A control drags onto an inspector field through `portConnect` (the
 *     arrangement's gesture machine for endpoints outside the column-groups).
 *   - "Locate" selects the clip / track, so the inspector shows the field.
 *   - The timeline toggle puts a device row under the tracks.
 *   - Lights (types, rigs) render as their own section after the MIDI groups.
 */

import { html } from 'lit';
import type { Sketch } from '../../../sketch-types';
import { setDevicesHost, type DevicesHost } from '../../devices/devices-host';
import { compositionSketches, type ClipSketch } from '../model/composition';
import { portConnect } from '../surfaces/arr-io';
import { store } from './store';

import '../surfaces/lights/light-devices-section';
import '../surfaces/displays/display-devices-section';
import '../surfaces/output-master-button';

/** A ClipSketch in the editor's Sketch shape (chain entries keyed by device id). */
function asSketch(sk: ClipSketch): Sketch {
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
}

/** "Track 1" / "Track 1 / Clip A". */
function sketchLabel(sketchId: string): string {
  const [kind, trackId, clipId] = sketchId.split('/');
  const t = store.laneById(trackId);
  const tn = t ? store.trackDisplayName(t) : '?';
  if (kind !== 'clip') return tn;
  return `${tn} / ${t?.clips.find((c) => c.id === clipId)?.name ?? '?'}`;
}

export const arrDevicesHost: DevicesHost = {
  sketches: () => {
    const out: Record<string, Sketch> = {};
    for (const [id, sk] of Object.entries(compositionSketches(store.composition))) out[id] = asSketch(sk);
    return out;
  },
  // The inspected sketch first, then document order.
  scanIds: () => {
    const all = Object.keys(compositionSketches(store.composition));
    const cur = store.primaryPath;
    return cur && all.includes(cur) ? [cur, ...all.filter((x) => x !== cur)] : all;
  },
  currentSketchId: () => store.primaryPath ?? null,
  sketchLabel,
  canEditWires: () => true,
  fieldDef: (moduleType, field) => {
    const p = store.enginePlugin(moduleType) as { schema?: Record<string, Record<string, any>> } | undefined;
    return p?.schema?.[field];
  },
  wireOps: (sketchId, wireId) => ({
    getWire: () => store.sketchWires(sketchId)?.find((w) => w.id === wireId),
    updateWire: (patch) => store.updateSketchWire(sketchId, wireId, patch as Record<string, unknown>),
    // A slider drag lands as ONE undo point: every step coalesces on the key.
    beginUpdateWire: (patch) => {
      const ck = `devwire:${wireId}`;
      store.updateSketchWire(sketchId, wireId, patch as Record<string, unknown>, ck);
      return { _ck: ck, accept: () => {}, cancel: () => {} } as { _ck: string; accept(): void; cancel(): void };
    },
    updateUpdateWire: (edit, patch) =>
      store.updateSketchWire(sketchId, wireId, patch as Record<string, unknown>, (edit as { _ck?: string })._ck),
  }),
  removeWire: (sketchId, wireId) => store.removeSketchWire(sketchId, wireId),
  locate: (sketchId) => {
    store.showRightTab('inspector');
    store.setSelection([sketchId]);
  },
  refreshScan: () => Promise.resolve(),
  scanning: () => false,
  wiresMode: () => store.wiresMode,
  connect: () => portConnect,
  filters: () => store.deviceFilters,
  setFilters: (f) => store.setDeviceFilters(f),
  // Clear of the right panel (+ its tab bar) and the clip panel.
  detailsInset: () => ({
    right: (store.sideCollapsed ? 0 : store.sidePanelWidth) + 44 + 12,
    bottom: (store.clipViewOpen ? store.clipViewHeight : 0) + 12,
  }),
  usageLabel: 'wired in this arrangement or shown on its timeline',
  renderLights: (o) => html`<light-devices-section .inUse=${o.inUse} .templates=${o.templates}
    .deleted=${o.deleted}></light-devices-section>`,
  renderHeader: () => html`<output-master-button></output-master-button>`,
  renderDisplays: (o) => html`<display-devices-section .inUse=${o.inUse}
    .deleted=${o.deleted}></display-devices-section>`,
  included: {
    has: (deviceId) => !!store.placementForDevice(deviceId),
    toggle: (deviceId, info) => {
      const p = store.placementForDevice(deviceId);
      if (p) store.removeDevicePlacement(p.id);
      else store.includeDevice(deviceId, info);
    },
  },
};

setDevicesHost(arrDevicesHost);
