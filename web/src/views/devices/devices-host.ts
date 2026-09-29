/**
 * The Devices panel's HOST — everything <devices-tab> and its children need
 * from the surface they're mounted in, so the same panel serves the sketch
 * editor (Remote Control / Effect Dev) and the arrangement.
 *
 * The editor's host (editor-devices-host.ts) wraps appController + the
 * composition-wide ghost scan; the arrangement's (arr-devices-host.ts) wraps
 * its store. A page installs its host once, on import of its surface; nothing
 * here imports either side.
 */

import type { Sketch } from '../../sketch-types';
import type { WireConnect } from '../../widgets/taps-connect';
import type { WireModOps } from '../../widgets/wire-mod-inspector';
import { midiController } from '../../state/midi-controller';
import { appState } from '../../state/app-state';
import { midiInstanceIdFromKey } from '../../midi/midi-types';
import { collectGhostDevices, type GhostDevice } from './device-wires-model';

/** The panel's group toggles (persisted by the host). */
export interface DeviceFilters {
  connected: boolean;
  disconnected: boolean;
  unrecognized: boolean;
  templates: boolean;
  deleted: boolean;
  /** Only devices this project uses (wired anywhere in it, or on its timeline). */
  inUse?: boolean;
}

export interface DevicesHost {
  /** Every sketch this project's device wires can live in, in the editor's
   *  Sketch shape (chain + wires + instances), keyed by sketch id. */
  sketches(): Record<string, Sketch | undefined>;
  /** The order the wires panel lists sketches in (the current one first). */
  scanIds(): string[];
  /** The sketch being edited (tagged "editing" in the wires panel), if any. */
  currentSketchId(): string | null;
  sketchLabel(sketchId: string): string;
  /** Can this sketch's wires be edited here? (Live: the edited instance only.) */
  canEditWires(sketchId: string): boolean;
  /** A module field's schema def (labels, raw, vector width). */
  fieldDef(moduleType: string, field: string): Record<string, any> | undefined;
  /** The wire-mod inspector's edit plumbing for one wire. */
  wireOps(sketchId: string, wireId: string): WireModOps;
  removeWire(sketchId: string, wireId: string): void;
  /** Show a wire's destination field (select / open, scroll, flash). */
  locate(sketchId: string, chainIdx: number, field: string): void;
  /** Re-read sketches the host can't see live (Live mode's other instances). */
  refreshScan(): Promise<void>;
  scanning(): boolean;
  /** Is W wire mode on (control hit zones shown)? */
  wiresMode(): boolean;
  /** The gesture machine control hit zones start wires on. */
  connect(): WireConnect;
  filters(): DeviceFilters;
  setFilters(f: DeviceFilters): void;
  /** Where the floating details panel sits (px from the viewport's right /
   *  bottom edges) — clear of a float monitor, or of a side panel. */
  detailsInset(): { right: number; bottom: number };
  /** "in this arrangement" / "in the composition" / "in this sketch". */
  usageLabel: string;
  /** Arrangement only: the "show on the timeline" toggle per device. */
  included?: {
    has(deviceId: string): boolean;
    toggle(deviceId: string, info: { label?: string; templateId?: string }): void;
  };
}

let host: DevicesHost | null = null;

export function setDevicesHost(h: DevicesHost): void {
  host = h;
}

export function devicesHost(): DevicesHost {
  if (!host) throw new Error('[devices] no DevicesHost installed for this page');
  return host;
}

/** Device ids this project uses: every `midi:` end of every wire (aliases
 *  resolved to the device that answers for them), plus the host's included
 *  devices. */
export function devicesInUse(h: DevicesHost): Set<string> {
  const referenced = new Set<string>();
  for (const sk of Object.values(h.sketches())) {
    for (const w of sk?.wires ?? []) {
      for (const end of [w.src, w.dest]) {
        const id = midiInstanceIdFromKey(end.instanceKey);
        if (id) referenced.add(id);
      }
    }
  }
  const out = new Set<string>();
  for (const inst of appState.local.midi.library) {
    if (inst.deleted) continue;
    if (referenced.has(inst.id) || (inst.knownAs ?? []).some((a) => referenced.has(a))
        || h.included?.has(inst.id)) {
      out.add(inst.id);
    }
  }
  return out;
}

/** Wires to devices the library doesn't know, over the host's sketches. */
export function hostGhosts(h: DevicesHost): GhostDevice[] {
  const sketches = h.sketches();
  return collectGhostDevices(sketches, Object.keys(sketches), midiController.knownDeviceIds());
}
